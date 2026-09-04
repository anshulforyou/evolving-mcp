import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTrace } from "../src/trace/format.js";
import { parseConfig } from "../src/config/schema.js";

/**
 * The whole pipeline against a server neither of us built anything for.
 *
 * Every server-specific assumption in this project so far was found by running
 * against a server that broke it, so the point of this test is a THIRD server:
 * not sqlite, not filesystem. It needs the network to fetch that server, so it
 * is opt-in with EMCP_E2E=1 rather than silently skipped in CI.
 */
const ENABLED = process.env["EMCP_E2E"] === "1";
const CLI = resolve("src/cli/main.ts");
const TSX = resolve("node_modules/tsx/dist/cli.mjs");
const SERVER = ["npx", "-y", "@modelcontextprotocol/server-everything"];

const run = (args: string[], cwd: string): string =>
  execFileSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("init, trace and report work end to end on a server this repo was not built for", { skip: !ENABLED && "set EMCP_E2E=1 to run" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-e2e-"));

  // 1. init discovers the tool surface and writes a config.
  run(["init", "--config", join(dir, "cfg.json"), "--", ...SERVER], dir);
  const cfg = parseConfig(JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8")), "cfg");
  assert.ok(Object.keys(cfg.tools).length > 3, "found a real tool surface");
  assert.ok(cfg.server, "recorded how to start the server");

  // 2. trace records traffic without disturbing it.
  const out = join(dir, "t.jsonl");
  const proxy = spawn(process.execPath, [TSX, CLI, "trace", "--config", join(dir, "cfg.json"), "--out", out, "--", ...SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const seen: string[] = [];
  let buf = "";
  proxy.stdout.setEncoding("utf8");
  proxy.stdout.on("data", (c: string) => {
    buf += c;
    let n: number;
    while ((n = buf.indexOf("\n")) >= 0) { seen.push(buf.slice(0, n)); buf = buf.slice(n + 1); }
  });
  proxy.stderr.resume();

  let id = 0;
  const send = (o: unknown) => proxy.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  // Four episodes of the same two-call shape, declared via traceparent so the
  // test does not depend on wall-clock gaps.
  for (let ep = 0; ep < 4; ep++) {
    const tp = { traceparent: `00-${String(ep).repeat(32).slice(0, 32)}-0000000000000001-01` };
    send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "echo", arguments: { message: "discovering" }, _meta: tp } });
    send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "add", arguments: { a: 2, b: 3 }, _meta: tp } });
  }
  // This server pushes unsolicited notifications, so counting output lines
  // conflates them with replies. Correlate on the request id, which is what
  // JSON-RPC asks for anyway.
  const answered = (): Set<number> => {
    const ids = new Set<number>();
    for (const l of seen) {
      try {
        const m = JSON.parse(l) as { id?: number };
        if (typeof m.id === "number") ids.add(m.id);
      } catch { /* not a frame we care about */ }
    }
    return ids;
  };
  const deadline = Date.now() + 25_000;
  while (answered().size < id && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  proxy.stdin.end();
  await new Promise((r) => { proxy.on("exit", r); setTimeout(() => { proxy.kill(); r(undefined); }, 4000); });

  assert.equal(answered().size, id, "every request got a response back through the proxy");
  assert.ok(seen.some((l) => l.includes("notifications/")), "server-pushed notifications came through too");

  const rows = parseTrace(readFileSync(out, "utf8"), out);
  assert.equal(rows.length, 8, "eight tool calls recorded");
  assert.equal(new Set(rows.map((r) => r.traceId)).size, 4, "four episodes, from the traceparent");
  assert.ok(rows.every((r) => r.boundary === "traceparent"));
  assert.ok(rows.every((r) => r.resultTokens > 0), "token counts are recomputed at read time");

  // 3. report runs and finds the repeated shape.
  const text = run(["report", "--config", join(dir, "cfg.json"), "--trace", out], dir);
  assert.match(text, /What your traffic says about your server/);
  assert.match(text, /episodes\s+4/);
  assert.doesNotMatch(text, /phase 0/, "the adopter report is not the research report");
  assert.doesNotMatch(text, /distinct goals/, "ground-truth sections stay out of real traffic");
});
