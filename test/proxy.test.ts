import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTrace } from "../src/trace/format.js";

const FAKE = resolve("test/fixtures/fake-server.mjs");
const CLI = resolve("src/cli/main.ts");
const TSX = resolve("node_modules/tsx/dist/cli.mjs");

interface Session {
  send(o: unknown): void;
  raw(s: string): void;
  lines: string[];
  done(): Promise<void>;
  proc: ChildProcessWithoutNullStreams;
}

function open(cmd: string, args: string[]): Session {
  const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c: string) => {
    buf += c;
    let n: number;
    while ((n = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, n));
      buf = buf.slice(n + 1);
    }
  });
  return {
    proc,
    lines,
    send: (o) => proc.stdin.write(JSON.stringify(o) + "\n"),
    raw: (s) => proc.stdin.write(s),
    done: () =>
      new Promise((r) => {
        proc.stdin.end();
        proc.on("exit", () => r());
        setTimeout(() => { proc.kill(); r(); }, 2500);
      }),
  };
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a condition instead of sleeping.
 *
 * A fixed sleep was used first and it failed the large-payload test by
 * sampling the proxy's output before tsx had even started, which looked
 * exactly like the proxy losing the message. It was not; the harness was.
 */
async function waitFor(ok: () => boolean, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(50);
  }
  return ok();
}

/** Output has arrived and then stopped arriving. */
async function settle(s: Session, timeoutMs = 12_000): Promise<void> {
  await waitFor(() => s.lines.length > 0, timeoutMs);
  let last = -1;
  while (last !== s.lines.length) {
    last = s.lines.length;
    await sleep(250);
  }
}

/** Runs one script directly against the fake server, and again through the proxy. */
async function bothWays(script: (s: Session) => void): Promise<{ direct: string[]; proxied: string[]; trace: string }> {
  const dir = mkdtempSync(join(tmpdir(), "emcp-proxy-"));
  const out = join(dir, "t.jsonl");

  const direct = open(process.execPath, [FAKE]);
  script(direct);
  await settle(direct);
  await direct.done();

  const proxied = open(process.execPath, [TSX, CLI, "trace", "--out", out, "--", process.execPath, FAKE]);
  script(proxied);
  // Wait for the proxy to match what the direct run produced, then let it
  // settle, so a slow start is never mistaken for a lost message.
  await waitFor(() => proxied.lines.length >= direct.lines.length);
  await settle(proxied);
  await proxied.done();

  return {
    direct: direct.lines,
    proxied: proxied.lines,
    trace: existsSync(out) ? readFileSync(out, "utf8") : "",
  };
}

test("every response through the proxy is byte-identical to talking directly", async () => {
  // The one property that matters. A proxy that quietly reformats the protocol
  // is worse than no proxy, and re-serializing a parsed object is enough to
  // change key order or number formatting.
  const { direct, proxied } = await bothWays((s) => {
    s.send(call(1, "normal"));
    s.send(call(2, "newlines"));
    s.send(call(3, "boom"));
    s.send(call(4, "burst"));
    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  });
  assert.deepEqual(proxied, direct);
});

test("a message split across writes is forwarded whole", async () => {
  const { direct, proxied } = await bothWays((s) => {
    const msg = JSON.stringify(call(1, "normal"));
    s.raw(msg.slice(0, 12));
    s.raw(msg.slice(12, 30));
    s.raw(msg.slice(30) + "\n");
  });
  assert.deepEqual(proxied, direct);
  assert.equal(proxied.length, 1);
});

test("several messages arriving in one write are all forwarded", async () => {
  const { direct, proxied } = await bothWays((s) => {
    s.raw(JSON.stringify(call(1, "normal")) + "\n" + JSON.stringify(call(2, "normal")) + "\n");
  });
  assert.deepEqual(proxied, direct);
  assert.equal(proxied.length, 2);
});

test("a payload far larger than one chunk survives intact", async () => {
  const { direct, proxied } = await bothWays((s) => s.send(call(1, "big")));
  assert.deepEqual(proxied, direct);
  assert.ok(proxied[0]!.length > 200000);
});

test("out-of-order responses are matched to the right call", async () => {
  const { trace } = await bothWays((s) => {
    s.send(call(1, "slow"));
    s.send(call(2, "normal"));
  });
  const rows = parseTrace(trace, "t");
  const slow = rows.find((r) => r.tool === "slow");
  const normal = rows.find((r) => r.tool === "normal");
  assert.ok(slow && normal, "both calls recorded");
  assert.match(JSON.stringify(slow!.result), /slow done/, "the slow reply went to the slow call");
  assert.match(JSON.stringify(normal!.result), /ok:normal/);
});

test("a JSON-RPC error is recorded as a failed call, not a successful one", async () => {
  const { trace } = await bothWays((s) => s.send(call(1, "boom")));
  const rows = parseTrace(trace, "t");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.isError, true);
});

test("notifications are forwarded and never recorded as calls", async () => {
  const { trace } = await bothWays((s) => {
    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.send(call(1, "normal"));
  });
  const rows = parseTrace(trace, "t");
  assert.equal(rows.length, 1, "only the tools/call is a call");
  assert.equal(rows[0]!.tool, "normal");
});

test("a client-declared traceparent decides the episode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-tp-"));
  const out = join(dir, "t.jsonl");
  const s = open(process.execPath, [TSX, CLI, "trace", "--out", out, "--", process.execPath, FAKE]);
  const tp = (t: string) => ({
    jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call",
    params: { name: "normal", arguments: {}, _meta: { traceparent: `00-${t}-0000000000000001-01` } },
  });
  s.send(tp("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  s.send(tp("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  s.send(tp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
  await waitFor(() => s.lines.length >= 3);
  await settle(s);
  await s.done();

  const rows = parseTrace(readFileSync(out, "utf8"), "t");
  assert.equal(rows.length, 3);
  assert.deepEqual([...new Set(rows.map((r) => r.traceId))].sort(), [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ]);
  assert.ok(rows.every((r) => r.boundary === "traceparent"));
  assert.deepEqual(rows.filter((r) => r.traceId.startsWith("a")).map((r) => r.seq), [0, 1]);
  assert.equal(rows.find((r) => r.traceId.startsWith("b"))!.seq, 0, "seq restarts in a new episode");
});

/* ------------------------------------------------------------------ */
/* serving routes                                                      */
/* ------------------------------------------------------------------ */

import { writeFileSync } from "node:fs";

/** A route over two of the fake server's tools, returning the second. */
const SERVED = {
  name: "normal_then_newlines.abc123",
  description: "two upstream calls as one",
  inputSchema: { type: "object", additionalProperties: false },
  steps: [
    { call: "normal", args: {} },
    { call: "newlines", args: {} },
  ],
  returns: 1,
  sourceSteps: [0, 1],
};

function serveSession(routes: unknown[], status: "active" | "proposed"): { dir: string; session: Session } {
  const dir = mkdtempSync(join(tmpdir(), "emcp-serve-"));
  writeFileSync(
    join(dir, "routes.json"),
    JSON.stringify({ version: 1, routes: routes.map((plan) => ({ plan, status, evidence: {} })) }),
  );
  const session = open(process.execPath, [
    TSX, CLI, "serve", "--store", join(dir, "routes.json"), "--out", join(dir, "t.jsonl"),
    "--", process.execPath, FAKE,
  ]);
  return { dir, session };
}

test("an active route appears in tools/list alongside the real tools", async () => {
  const { session } = serveSession([SERVED], "active");
  session.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await waitFor(() => session.lines.length >= 1);
  await session.done();

  const result = JSON.parse(session.lines[0]!) as { result: { tools: Array<{ name: string }> } };
  const names = result.result.tools.map((t) => t.name);
  assert.equal((result.result as unknown as { ttlMs: number }).ttlMs, 300000, "the rest of the result is preserved");
  assert.deepEqual(names.slice(0, 3), ["normal", "newlines", "boom"], "the upstream tools are untouched and in order");
  assert.ok(names.includes(SERVED.name), "and the route was appended");
});

test("a proposed route is not served, which is what propose mode means", async () => {
  const { session } = serveSession([SERVED], "proposed");
  session.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await waitFor(() => session.lines.length >= 1);
  await session.done();
  const result = JSON.parse(session.lines[0]!) as { result: { tools: Array<{ name: string }> } };
  assert.ok(!result.result.tools.some((t) => t.name === SERVED.name));
});

test("calling a route runs its upstream calls and returns the last result", async () => {
  const { session } = serveSession([SERVED], "active");
  session.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: SERVED.name, arguments: {} } });
  await waitFor(() => session.lines.length >= 1);
  await settle(session);
  await session.done();

  assert.equal(session.lines.length, 1, "the route's own upstream calls never reach the client");
  const msg = JSON.parse(session.lines[0]!) as { id: number; result: { content: Array<{ text: string }> } };
  assert.equal(msg.id, 7, "answered under the client's own request id");
  assert.equal(msg.result.content[0]!.text, "a\nb\nc", "the last step's result came back");
});

test("a failing route reports a tool error rather than breaking the session", async () => {
  const broken = { ...SERVED, name: "broken.abc123", steps: [{ call: "boom", args: {} }], returns: 0, sourceSteps: [0] };
  const { session } = serveSession([broken], "active");
  session.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: broken.name, arguments: {} } });
  await waitFor(() => session.lines.length >= 1);
  await session.done();
  const msg = JSON.parse(session.lines[0]!) as { id: number; result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(msg.id, 3);
  assert.equal(msg.result.isError, true, "a tool execution error the model can read and recover from");
  assert.match(msg.result.content[0]!.text, /broken\.abc123 failed/);
});

test("everything that is not a route is still forwarded byte for byte while serving", async () => {
  // The runtime rewrites exactly two things: a tools/list result, and a call
  // to a promoted route. Nothing else may change.
  const direct = open(process.execPath, [FAKE]);
  const script = (s: Session) => {
    s.send(call(1, "normal"));
    s.send(call(2, "newlines"));
    s.send(call(3, "boom"));
  };
  script(direct);
  await settle(direct);
  await direct.done();

  const { session } = serveSession([SERVED], "active");
  script(session);
  await waitFor(() => session.lines.length >= direct.lines.length);
  await settle(session);
  await session.done();

  assert.deepEqual(session.lines, direct.lines);
});
