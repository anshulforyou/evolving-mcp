/**
 * A recording proxy.
 *
 * It sits between an MCP client and the server that client already talks to,
 * speaks stdio in both directions, and writes down every tools/call it sees.
 * The author points their existing client at this instead of at their server,
 * works normally for a while, and ends up with a trace.
 *
 * It is instrumentation, not the product. It never rewrites a message, never
 * adds a tool, never blocks a call, and never delays one to think about it.
 *
 * The rule that matters: **forward the raw bytes**. Every line goes across
 * exactly as it arrived, and parsing happens on a copy. Re-serializing a
 * parsed object would be enough to change key order or number formatting, and
 * a proxy that quietly rewrites the protocol is worse than no proxy.
 *
 * When routes are being served there are exactly two exceptions, and they are
 * the entire runtime:
 *
 *   1. A `tools/list` RESULT is rewritten to append the promoted routes. This
 *      is the one message whose bytes change, and it changes only by gaining
 *      entries in its `tools` array.
 *   2. A `tools/call` naming a promoted route is answered here instead of
 *      being forwarded. The route's own upstream calls go out on a separate
 *      id space so they can never collide with the client's, and their
 *      replies are consumed here rather than reaching the client.
 *
 * Everything else, including every call to a tool the upstream server really
 * has, is still forwarded byte for byte.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { rawText } from "../detect/normalize.js";
import { TRACE_VERSION, type Boundary, type TraceRow } from "./format.js";
import { runRoute } from "../detect/interpret.js";
import type { Json, RoutePlan } from "../types.js";

/** Our own calls use string ids with this prefix. Client ids are whatever the
 *  client chose, so a distinct shape is what guarantees no collision. */
const INTERNAL_PREFIX = "emcp-";

export interface ProxyOptions {
  command: string;
  args: string[];
  out: string;
  /** Routes to serve. Empty or absent means pure recording, and then the proxy
   *  is byte-transparent in both directions. */
  routes?: RoutePlan[];
  /** Silence after which the next call begins a new episode, when the client
   *  gives us no trace context of its own. */
  idleGapMs: number;
  /** Where the proxy's own commentary goes. Never stdout: that is the
   *  protocol channel and anything extra on it corrupts the session. */
  log?: (msg: string) => void;
}

interface Pending {
  tool: string;
  args: Json;
  startedAt: number;
  traceId: string;
  seq: number;
  boundary: Boundary;
  caller: string;
}

/** Splits a stream into complete lines without ever holding a partial one. */
function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  };
}

const asObject = (line: string): Record<string, Json> | null => {
  const t = line.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
  try {
    const v = JSON.parse(t) as Json;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, Json>) : null;
  } catch {
    return null;
  }
};

/** W3C traceparent is `00-<trace-id>-<span-id>-<flags>`. */
function traceIdFrom(meta: Json | undefined): string | undefined {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const tp = (meta as Record<string, Json>)["traceparent"];
  if (typeof tp !== "string") return undefined;
  const parts = tp.split("-");
  return parts.length >= 3 && parts[1] && /^[0-9a-f]{32}$/i.test(parts[1]) ? parts[1] : undefined;
}

export class RecordingProxy {
  private upstream: ChildProcessWithoutNullStreams;
  private sink: WriteStream;
  private pending = new Map<string | number, Pending>();
  private episode = randomUUID().replace(/-/g, "");
  private episodeSeq = 0;
  private lastCallAt = 0;
  private episodeBoundary: Boundary = "process";
  private everSawTraceparent = false;
  private counts = { calls: 0, episodes: 1, routeCalls: 0 };
  private routes = new Map<string, RoutePlan>();
  /** Client request ids whose response must have routes appended. */
  private listRequests = new Set<string | number>();
  /** Our own in-flight upstream calls, keyed by internal id. */
  private internal = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private internalSeq = 0;

  constructor(private readonly opts: ProxyOptions) {
    for (const r of opts.routes ?? []) this.routes.set(r.name, r);
    mkdirSync(dirname(opts.out) || ".", { recursive: true });
    this.sink = createWriteStream(opts.out, { flags: "a" });
    this.upstream = spawn(opts.command, opts.args, { stdio: ["pipe", "pipe", "pipe"] });

    // Client to server. Forward first, record second: a slow write to our own
    // log must never sit in front of somebody's tool call.
    const fromClient = lineSplitter((line) => {
      // A call to a promoted route is answered here and never forwarded, so
      // the decision has to happen before the write.
      if (this.tryServeRoute(line)) return;
      this.upstream.stdin.write(line + "\n");
      this.onClientLine(line);
    });
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => fromClient(c));
    process.stdin.on("end", () => this.upstream.stdin.end());

    const fromServer = lineSplitter((line) => {
      // Replies to our own calls belong to us, not to the client.
      if (line.includes(`"${INTERNAL_PREFIX}`) && this.tryConsumeInternal(line)) return;
      process.stdout.write(this.withRoutes(line) + "\n");
      this.onServerLine(line);
    });
    this.upstream.stdout.setEncoding("utf8");
    this.upstream.stdout.on("data", (c: string) => fromServer(c));

    // The server's stderr is its own; pass it through untouched.
    this.upstream.stderr.on("data", (c: Buffer) => process.stderr.write(c));

    this.upstream.on("exit", (code) => {
      // NOT process.exit(). That terminates immediately and truncates whatever
      // is still queued on stdout, which silently loses the tail of a large
      // response. A 200KB payload disappeared entirely until a test caught it.
      // Setting exitCode and letting the streams drain is the only safe way to
      // end a process that is in the middle of forwarding somebody's protocol.
      process.exitCode = code ?? 0;
      this.sink.end();
      process.stdin.pause();
      process.stdout.end?.();
    });
  }

  /** Appends promoted routes to a tools/list result. The only rewritten bytes. */
  private withRoutes(line: string): string {
    if (!this.routes.size) return line;
    const msg = asObject(line);
    if (!msg) return line;
    const id = msg["id"];
    if ((typeof id !== "number" && typeof id !== "string") || !this.listRequests.has(id)) return line;
    this.listRequests.delete(id);
    const result = msg["result"];
    if (typeof result !== "object" || result === null || Array.isArray(result)) return line;
    const r = result as Record<string, Json>;
    if (!Array.isArray(r["tools"])) return line;
    r["tools"] = [
      ...(r["tools"] as Json[]),
      ...[...this.routes.values()].map((p) => ({
        name: p.name,
        description: p.description,
        inputSchema: p.inputSchema as Json,
      })),
    ] as Json;
    return JSON.stringify(msg);
  }

  /** Answers a call to a promoted route. Returns true when it handled the line. */
  private tryServeRoute(line: string): boolean {
    if (!this.routes.size) return false;
    const msg = asObject(line);
    if (!msg || msg["method"] !== "tools/call") return false;
    const id = msg["id"];
    if (typeof id !== "number" && typeof id !== "string") return false;
    const params = msg["params"];
    if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
    const p = params as Record<string, Json>;
    const plan = typeof p["name"] === "string" ? this.routes.get(p["name"]) : undefined;
    if (!plan) return false;

    const args = (p["arguments"] ?? {}) as Record<string, Json>;
    const meta = p["_meta"];
    this.counts.routeCalls++;

    void runRoute(plan, args, {
      // Every upstream call the route makes carries the CALLER's own request
      // metadata, so their credentials and not the ones this route was mined
      // from. Authorization stays entirely the upstream server's decision.
      callTool: (name, callArgs) => this.callUpstream(name, callArgs, meta),
    })
      .then(({ result }) => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      })
      .catch((e: Error) => {
        // A tool execution error, not a protocol error: the model can read it
        // and fall back to the underlying tools.
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `route ${plan.name} failed: ${e.message}` }], isError: true },
          }) + "\n",
        );
      });
    return true;
  }

  private callUpstream(name: string, args: Json, meta: Json | undefined): Promise<Json> {
    const id = `${INTERNAL_PREFIX}${++this.internalSeq}`;
    const params: Record<string, Json> = { name, arguments: args };
    if (meta !== undefined) params["_meta"] = meta;
    const done = new Promise<Json>((resolve, reject) => {
      this.internal.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.internal.delete(id)) reject(new Error(`upstream call ${name} timed out`));
      }, 30_000);
    });
    this.upstream.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }) + "\n");
    return done;
  }

  private tryConsumeInternal(line: string): boolean {
    const msg = asObject(line);
    if (!msg) return false;
    const id = msg["id"];
    if (typeof id !== "string" || !id.startsWith(INTERNAL_PREFIX)) return false;
    const waiter = this.internal.get(id);
    if (!waiter) return false;
    this.internal.delete(id);
    if (msg["error"]) waiter.reject(new Error(JSON.stringify(msg["error"])));
    else waiter.resolve((msg["result"] ?? null) as Json);
    return true;
  }

  private onClientLine(line: string): void {
    const msg = asObject(line);
    if (!msg) return;
    if (msg["method"] === "tools/list") {
      const id = msg["id"];
      if (typeof id === "number" || typeof id === "string") this.listRequests.add(id);
      return;
    }
    if (msg["method"] !== "tools/call") return;
    const id = msg["id"];
    if (typeof id !== "number" && typeof id !== "string") return;
    const params = msg["params"];
    if (typeof params !== "object" || params === null || Array.isArray(params)) return;
    const p = params as Record<string, Json>;
    const tool = p["name"];
    if (typeof tool !== "string") return;

    const meta = p["_meta"];
    const declared = traceIdFrom(meta);
    let boundary: Boundary;
    const now = Date.now();

    if (declared) {
      this.everSawTraceparent = true;
      if (declared !== this.episode) {
        this.episode = declared;
        this.episodeSeq = 0;
        this.counts.episodes++;
      }
      boundary = "traceparent";
    } else if (this.lastCallAt && now - this.lastCallAt > this.opts.idleGapMs) {
      this.episode = randomUUID().replace(/-/g, "");
      this.episodeSeq = 0;
      this.counts.episodes++;
      boundary = "idle-gap";
    } else {
      // Same episode as the last call. The boundary field describes how this
      // EPISODE was decided, not this call, so it inherits rather than being
      // recomputed. Tagging every subsequent call "idle-gap" because a gap
      // could have happened was simply wrong.
      boundary = this.episodeBoundary;
    }
    this.episodeBoundary = boundary;
    this.lastCallAt = now;

    const clientInfo = (meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, Json>)["io.modelcontextprotocol/clientInfo"]
      : undefined) as Record<string, Json> | undefined;

    this.pending.set(id, {
      tool,
      args: (p["arguments"] ?? {}) as Json,
      startedAt: now,
      traceId: this.episode,
      seq: this.episodeSeq++,
      boundary,
      caller: typeof clientInfo?.["name"] === "string" ? (clientInfo["name"] as string) : "unknown",
    });
  }

  private onServerLine(line: string): void {
    const msg = asObject(line);
    if (!msg) return;
    const id = msg["id"];
    if (typeof id !== "number" && typeof id !== "string") return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);

    const result = (msg["result"] ?? msg["error"] ?? null) as Json;
    const flagged =
      typeof result === "object" && result !== null && !Array.isArray(result)
        ? (result as Record<string, Json>)["isError"] === true
        : false;

    // Bytes only. Counting TOKENS here was a real bug: tokenizing a 200KB
    // result takes long enough to block the event loop, which stalls the very
    // protocol channel this thing is supposed to forward untouched. A test
    // caught it as 8KB of a 200KB response arriving and then nothing.
    //
    // The trace format makes resultTokens optional and recomputes it, so the
    // cost belongs at report time where nobody is waiting on it.
    const bytes = Buffer.byteLength(rawText(result), "utf8");

    const row: Omit<TraceRow, "resultTokens"> = {
      version: TRACE_VERSION,
      traceId: p.traceId,
      seq: p.seq,
      tsMs: p.startedAt,
      caller: p.caller,
      tool: p.tool,
      args: p.args,
      result,
      isError: flagged || msg["error"] !== undefined,
      latencyMs: Math.round((Date.now() - p.startedAt) * 1000) / 1000,
      resultBytes: bytes,
      boundary: p.boundary,
    };
    this.counts.calls++;
    // Off the forwarding path entirely. Serializing a large row is not free
    // either, and nothing downstream is waiting for it.
    setImmediate(() => this.sink.write(JSON.stringify(row) + "\n"));
  }

  stats(): { calls: number; episodes: number; routeCalls: number } {
    return { ...this.counts };
  }
}
