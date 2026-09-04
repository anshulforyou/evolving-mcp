import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptyStore, loadStore, saveStore, StoreError, activeRoutes, type StoredRoute } from "../src/runtime/store.js";
import { promote } from "../src/runtime/promote.js";
import { analyze } from "../src/detect/dataflow.js";
import { detect as detectAll, segment as segmentAll } from "../src/detect/index.js";
import { parseConfig } from "../src/config/schema.js";
import type { Cluster, Episode, Json, LabelledCall, RecordedCall, RoutePlan } from "../src/types.js";
import type { Selection as Sel } from "../src/detect/select.js";

/* ------------------------------------------------------------------ */
/* the sensitive-value guard                                           */
/* ------------------------------------------------------------------ */

let seq = 0;
const call = (tool: string, args: Json, text: string): LabelledCall => ({
  traceId: "t", seq: seq++, tsMs: 0, caller: "c", tool, args, goalId: "g", variant: "v",
  result: { content: [{ type: "text", text }], isError: false },
  isError: false, latencyMs: 1, resultBytes: 0, resultTokens: 10,
});

function clusterOf(...runs: LabelledCall[][]): Cluster {
  const members = runs.map((calls, i) => {
    const ep: Episode = { traceId: `t${i}`, caller: "c", calls };
    return { episode: ep, start: 0, end: calls.length };
  });
  return { shape: { key: "k", tools: runs[0]!.map((c) => c.tool) }, members };
}

const sensitiveCfg = parseConfig(
  { version: 1, tools: { fetch: { mutability: "read-only", sensitive: ["$.tenant"] }, q: { mutability: "read-only" } } },
  "test",
);

test("a value marked sensitive is never folded, even when every caller sent the same one", () => {
  // The whole point: stable does not mean shareable. A tenant id identical
  // across the cluster would otherwise become a const, and every later caller
  // would run a route carrying somebody else's identity.
  const mk = () => [call("fetch", { tenant: "acme", page: 1 }, "rows")];
  const out = analyze(clusterOf(mk(), mk(), mk()), sensitiveCfg);
  const tenant = out.find((a) => a.argPath === "$.tenant")!;
  assert.equal(tenant.role, "param", "must be supplied by the caller");
  assert.equal(tenant.binding?.kind, "param");
  assert.match(tenant.note ?? "", /sensitive/);
});

test("without the marking, the same value would have been folded", () => {
  const mk = () => [call("fetch", { tenant: "acme", page: 1 }, "rows")];
  const out = analyze(clusterOf(mk(), mk(), mk()));
  assert.equal(out.find((a) => a.argPath === "$.tenant")!.role, "const", "which is exactly the risk");
});

test("a route is refused when a sensitive value hid inside someone else's string", () => {
  // Marking the field it came from would not have saved it: the value reaches
  // the route as a SQL literal in a different argument.
  const mk = (page: number) => [
    call("fetch", { tenant: "acme", page }, "rows"),
    call("q", { sql: `SELECT * FROM t WHERE tenant = 'acme' LIMIT ${page}` }, "rows"),
  ];
  const out = analyze(clusterOf(mk(1), mk(2), mk(3)), sensitiveCfg);
  const sql = out.find((a) => a.argPath === "$.sql")!;
  assert.equal(sql.role, "unstable", "the cluster is refused rather than promoted with the value in it");
  assert.equal(sql.binding, undefined);
  assert.match(sql.note ?? "", /sensitive/);
});

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

const plan = (name: string): RoutePlan => ({
  name, description: "d", inputSchema: { type: "object" },
  steps: [{ call: "normal", args: {} }], returns: 0, sourceSteps: [0],
});

const stored = (name: string, payoff: number): StoredRoute => ({
  plan: plan(name),
  evidence: { support: 5, tokensSaved: 100, schemaTokenCost: 10, payoffRatio: payoff, upstreamCallsPruned: 1, firstSeen: "2026-01-01" },
  status: "proposed",
});

test("a store round-trips and is written sorted, so a diff shows real changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-store-"));
  const p = join(dir, "routes.json");
  saveStore(p, { version: 1, routes: [stored("zeta", 2), stored("alpha", 3)] });
  assert.deepEqual(loadStore(p).routes.map((r) => r.plan.name), ["alpha", "zeta"]);
});

test("a missing store is empty, a malformed one throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-store-"));
  assert.deepEqual(loadStore(join(dir, "nope.json")), emptyStore());
  for (const bad of ['{"version":2,"routes":[]}', '{"version":1}', '{"version":1,"routes":[{"status":"maybe"}]}', "not json"]) {
    const p = join(dir, "bad.json");
    writeFileSync(p, bad);
    assert.throws(() => loadStore(p), StoreError, `should reject ${bad}`);
  }
});

test("duplicate route names are rejected, because MCP does not allow them", () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-store-"));
  const p = join(dir, "dup.json");
  writeFileSync(p, JSON.stringify({ version: 1, routes: [stored("same", 2), stored("same", 3)] }));
  assert.throws(() => loadStore(p), /duplicate route names/);
});

test("only active routes are served", () => {
  const routes = [stored("a", 2), { ...stored("b", 2), status: "active" as const }];
  assert.deepEqual(activeRoutes({ version: 1, routes }).map((p) => p.name), ["b"]);
});

/* ------------------------------------------------------------------ */
/* promotion                                                           */
/* ------------------------------------------------------------------ */

const selection = (name: string, tokens: number, mutating = false): Sel => ({
  candidate: {
    cluster: { shape: { key: name, tools: ["normal"] }, members: [] },
    analyses: [],
    plan: plan(name),
    score: {
      support: 5, intermediateTokensSaved: tokens, rawIntermediateTokensSaved: tokens,
      roundTripsSaved: 1, upstreamCallsPruned: 1, upstreamLatencyMs: 1,
      schemaTokenCost: 10, mutating, stable: true, payoffRatio: 1,
    },
  },
  incrementalTokens: tokens,
  incrementalCalls: 5,
});

test("propose mode never marks a route active", () => {
  const r = promote(emptyStore(), [selection("a", 5000)], undefined);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0]!.status, "proposed");
  assert.equal(activeRoutes(r.store).length, 0, "nothing is served without a human saying so");
});

test("live mode serves immediately", () => {
  const cfg = parseConfig({ version: 1, tools: {}, runtime: { mode: "live" } }, "t");
  const r = promote(emptyStore(), [selection("a", 5000)], cfg);
  assert.equal(r.added[0]!.status, "active");
});

test("a route containing a mutating or unclassified call is refused", () => {
  const r = promote(emptyStore(), [selection("a", 5000, true)], undefined);
  assert.equal(r.added.length, 0);
  assert.match(r.rejected[0]!.why, /mutating or unclassified/);
});

test("a route that saves less than its own schema costs is refused", () => {
  const r = promote(emptyStore(), [selection("a", 5)], undefined); // 5 saved against 10+ schema
  assert.equal(r.added.length, 0);
  assert.match(r.rejected[0]!.why, /less than its own schema/);
});

test("the surface is capped, and a stronger candidate displaces the weakest", () => {
  // There is no eviction, so this is the only thing bounding what every caller
  // pays on every request.
  const cfg = parseConfig({ version: 1, tools: {}, runtime: { maxRoutes: 2 } }, "t");
  let store = promote(emptyStore(), [selection("weak", 200), selection("mid", 4000)], cfg).store;
  assert.equal(store.routes.length, 2);

  const r = promote(store, [selection("strong", 90000)], cfg);
  assert.equal(r.store.routes.length, 2, "still capped");
  assert.deepEqual(r.displaced.map((d) => d.plan.name), ["weak"]);
  assert.ok(r.store.routes.some((x) => x.plan.name === "strong"));

  const weaker = promote(r.store, [selection("tiny", 150)], cfg);
  assert.equal(weaker.added.length, 0);
  assert.match(weaker.rejected[0]!.why, /surface is full/);
});

test("a route already activated is not silently reverted when seen again", () => {
  const store = { version: 1, routes: [{ ...stored("a", 2), status: "active" as const }] };
  const r = promote(store, [selection("a", 5000)], undefined);
  assert.equal(r.store.routes[0]!.status, "active");
  assert.equal(r.updated.length, 1);
  assert.equal(r.added.length, 0);
});

test("a merged route is classified with the same config as an unmerged one", () => {
  // This regressed once: the merge path rescored without the config, so every
  // merged route reported as mutating and promotion refused the strongest
  // routes in the corpus while accepting the weakest.
  const cfg = parseConfig(
    { version: 1, tools: { list: { mutability: "read-only" }, describe: { mutability: "read-only" }, fetch: { mutability: "read-only" } } },
    "test",
  );
  const mk = (id: string, explore: number) => {
    const calls: LabelledCall[] = [call("list", {}, '[{"n":"a"}]')];
    for (let i = 0; i < explore; i++) calls.push(call("describe", { of: `t${i}` }, `[{"c":${i}}]`));
    calls.push(call("fetch", { target: "the-one" }, "contents"));
    return calls.map((c, i) => ({ ...c, traceId: id, seq: i }));
  };
  const episodes = [mk("a1", 1), mk("a2", 1), mk("a3", 1), mk("b1", 2), mk("b2", 2), mk("b3", 2)];
  const cands = detectAll(segmentAll(episodes.flat()), { minSupport: 3, minLength: 2, maxLength: 8, config: cfg });
  const withPlan = cands.filter((c) => c.plan);
  assert.equal(withPlan.length, 1, "the two exploration depths merged");
  assert.equal(withPlan[0]!.score.support, 6);
  assert.equal(withPlan[0]!.score.mutating, false, "and the merged route is still read-only");
});

test("a route carrying a portability placeholder is refused, not served", () => {
  // Mining from this repo's own committed corpora produces constants holding
  // {TREE}. Serving one sends the upstream server a path that does not exist,
  // and it looks fine until the first call.
  const withPlaceholder: RoutePlan = {
    ...plan("placeholder.abc"),
    steps: [{ call: "read", args: { path: { kind: "const", value: "{TREE}/src/server.js" } } }],
  };
  const sel = selection("placeholder.abc", 5000);
  sel.candidate.plan = withPlaceholder;
  const r = promote(emptyStore(), [sel], undefined);
  assert.equal(r.added.length, 0);
  assert.match(r.rejected[0]!.why, /placeholder/);
});
