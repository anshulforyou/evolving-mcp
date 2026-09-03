import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, resetParamNames } from "../src/detect/dataflow.js";
import { tokenize } from "../src/detect/dataflow.js";
import type { Cluster, Episode, Json, RecordedCall } from "../src/types.js";

let seq = 0;
const call = (tool: string, args: Json, result: Json): RecordedCall => ({
  traceId: "t", seq: seq++, tsMs: 0, caller: "c", tool, args, result,
  isError: false, latencyMs: 1, resultBytes: 0, resultTokens: 10,
});

/** Wraps a payload the way an MCP tool result carries it. */
const text = (s: string): Json => ({ content: [{ type: "text", text: s }], isError: false });

function clusterOf(...runs: RecordedCall[][]): Cluster {
  const members = runs.map((calls, i) => {
    const ep: Episode = { traceId: `t${i}`, caller: "c", calls };
    return { episode: ep, start: 0, end: calls.length };
  });
  return { shape: { key: "k", tools: runs[0]!.map((c) => c.tool) }, members };
}

test("identical values become a const", () => {
  resetParamNames();
  const c = clusterOf(
    [call("get", { table: "users" }, text("[]"))],
    [call("get", { table: "users" }, text("[]"))],
    [call("get", { table: "users" }, text("[]"))],
  );
  const [a] = analyze(c);
  assert.equal(a!.role, "const");
  assert.deepEqual(a!.binding, { kind: "const", value: "users" });
});

test("a value read out of an earlier result at a stable path becomes derived", () => {
  resetParamNames();
  const mk = (id: number) => [
    call("find", {}, text(`[{"id": ${id}}]`)),
    call("fetch", { id }, text("ok")),
  ];
  const a = analyze(clusterOf(mk(1), mk(2), mk(3))).find((x) => x.step === 1);
  assert.equal(a!.role, "derived");
  assert.deepEqual(a!.binding, { kind: "from", step: 0, path: "$[0].id" });
});

test("a value that varies and appears nowhere earlier becomes a plain param", () => {
  resetParamNames();
  const mk = (name: string) => [call("greet", { name }, text("hi"))];
  const [a] = analyze(clusterOf(mk("ana"), mk("bo"), mk("cy")));
  assert.equal(a!.role, "param");
  assert.equal(a!.discoveredIn, undefined, "nothing earlier held it, so it is free");
});

test("a param whose value only exists in an earlier result is flagged as discovered", () => {
  resetParamNames();
  // The value appears earlier but at a different path each time, so it cannot
  // be derived. It is still not free: the caller had to make step 0 to know it.
  const mk = (pos: number, name: string) => {
    const rows = ["aa", "bb", "cc"];
    rows[pos] = name;
    return [
      call("list", {}, text(JSON.stringify(rows.map((n) => ({ n }))))),
      call("open", { n: name }, text("ok")),
    ];
  };
  const a = analyze(clusterOf(mk(0, "x1"), mk(1, "y2"), mk(2, "z3"))).find((x) => x.step === 1);
  assert.equal(a!.role, "param");
  assert.equal(a!.discoveredIn, 0);
});

test("a value embedded in a composed string is templated, not treated as opaque", () => {
  resetParamNames();
  const mk = (id: number) => [
    call("find", {}, text(`[{"cid": ${id}}]`)),
    call("query", { q: `SELECT * FROM t WHERE cid = ${id} ORDER BY x` }, text("rows")),
  ];
  const a = analyze(clusterOf(mk(11), mk(22), mk(33))).find((x) => x.step === 1);
  assert.equal(a!.role, "derived");
  assert.equal((a!.binding as { kind: string }).kind, "template");
  const parts = (a!.binding as { parts: unknown[] }).parts;
  assert.deepEqual(parts[0], "SELECT * FROM t WHERE cid = ");
  assert.deepEqual(parts[1], { kind: "from", step: 0, path: "$[0].cid" });
  assert.deepEqual(parts[2], " ORDER BY x");
});

test("strings that differ structurally are unstable rather than force-fitted", () => {
  resetParamNames();
  const c = clusterOf(
    [call("query", { q: "SELECT a FROM t" }, text("1"))],
    [call("query", { q: "SELECT a, b, c FROM t WHERE x = 1 GROUP BY a" }, text("2"))],
    [call("query", { q: "SELECT count(*) FROM u" }, text("3"))],
  );
  const [a] = analyze(c);
  assert.equal(a!.role, "unstable");
  assert.match(a!.note ?? "", /differ in structure/);
});

test("tokenize round-trips exactly, so templates can rebuild the original", () => {
  for (const s of ["SELECT * FROM t WHERE a = 'x''y' AND b = 12.5", "a  b\tc", ""]) {
    assert.equal(tokenize(s).join(""), s);
  }
});
