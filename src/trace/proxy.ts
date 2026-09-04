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
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { rawText } from "../detect/normalize.js";
import { TRACE_VERSION, type Boundary, type TraceRow } from "./format.js";
import type { Json } from "../types.js";

export interface ProxyOptions {
  command: string;
  args: string[];
  out: string;
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
  private counts = { calls: 0, episodes: 1 };

  constructor(private readonly opts: ProxyOptions) {
    mkdirSync(dirname(opts.out) || ".", { recursive: true });
    this.sink = createWriteStream(opts.out, { flags: "a" });
    this.upstream = spawn(opts.command, opts.args, { stdio: ["pipe", "pipe", "pipe"] });

    // Client to server. Forward first, record second: a slow write to our own
    // log must never sit in front of somebody's tool call.
    const fromClient = lineSplitter((line) => {
      this.upstream.stdin.write(line + "\n");
      this.onClientLine(line);
    });
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => fromClient(c));
    process.stdin.on("end", () => this.upstream.stdin.end());

    const fromServer = lineSplitter((line) => {
      process.stdout.write(line + "\n");
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

  private onClientLine(line: string): void {
    const msg = asObject(line);
    if (!msg || msg["method"] !== "tools/call") return;
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

  stats(): { calls: number; episodes: number } {
    return { ...this.counts };
  }
}
