import { test } from "node:test";
import assert from "node:assert/strict";
import { prune } from "../src/detect/prune.js";
import { detect, segment } from "../src/detect/index.js";
import { parseConfig, type Config } from "../src/config/schema.js";
import type { Episode, Json, LabelledCall, PlanStep } from "../src/types.js";

/** Every tool here is declared read-only, so pruning is permitted at all.
 *  With no config nothing is skippable, which is the safe default and is
 *  covered in config.test.ts. */
const readOnly = (...tools: string[]): Config =>
  parseConfig(
    { version: 1, tools: Object.fromEntries(tools.map((t) => [t, { mutability: "read-only" }])) },
    "test",
  );

const step = (call: string, args: PlanStep["args"]): PlanStep => ({ call, args });
const from = (s: number, path = "$[0].id") => ({ kind: "from" as const, step: s, path });

test("with no config nothing is dropped, because nothing is known to be safe", () => {
  const p = prune([step("list", {}), step("fetch", { id: { kind: "const", value: 1 } })], 1);
  assert.deepEqual(p.steps.map((s) => s.call), ["list", "fetch"]);
  assert.equal(p.removed, 0);
});

test("a step nothing reads is dropped", () => {
  const p = prune([step("list", {}), step("fetch", { id: { kind: "const", value: 1 } })], 1, readOnly("list", "fetch"));
  assert.deepEqual(p.steps.map((s) => s.call), ["fetch"]);
  assert.deepEqual(p.sourceSteps, [1]);
  assert.equal(p.removed, 1);
});

test("a step something binds to is kept", () => {
  const p = prune([step("list", {}), step("fetch", { id: from(0) })], 1, readOnly("list", "fetch"));
  assert.deepEqual(p.steps.map((s) => s.call), ["list", "fetch"]);
  assert.equal(p.removed, 0);
});

test("a mutating step is kept even when nothing reads it", () => {
  const p = prune(
    [step("write_query", { q: { kind: "const", value: "x" } }), step("read_query", { q: { kind: "const", value: "y" } })],
    1,
    parseConfig({ version: 1, tools: { write_query: { mutability: "mutating" }, read_query: { mutability: "read-only" } } }, "test"),
  );
  assert.deepEqual(p.steps.map((s) => s.call), ["write_query", "read_query"]);
});

test("the returned step is always kept", () => {
  const p = prune([step("a", {}), step("b", {})], 0, readOnly("a", "b"));
  assert.deepEqual(p.steps.map((s) => s.call), ["a"]);
  assert.equal(p.returns, 0);
});

test("surviving bindings are renumbered to their new positions", () => {
  // 0 unread, 1 read by 2. After pruning, 1 becomes 0 and the binding follows.
  const p = prune([step("noise", {}), step("list", {}), step("fetch", { id: from(1) })], 2, readOnly("noise", "list", "fetch"));
  assert.deepEqual(p.steps.map((s) => s.call), ["list", "fetch"]);
  assert.deepEqual(p.steps[1]!.args["id"], from(0));
  assert.equal(p.returns, 1);
});

test("pruning runs to a fixed point", () => {
  // 1 reads 0, but 1 is itself unread. Dropping 1 must then free 0.
  const p = prune([step("a", {}), step("b", { x: from(0) }), step("c", { y: { kind: "const", value: 1 } })], 2, readOnly("a", "b", "c"));
  assert.deepEqual(p.steps.map((s) => s.call), ["c"]);
  assert.equal(p.removed, 2);
});

test("a binding is never left pointing at a step that was removed", () => {
  for (const returns of [1, 2]) {
    const p = prune([step("a", {}), step("b", { x: from(0) }), step("c", { y: from(1) })], returns, readOnly("a", "b", "c"));
    for (const [i, s] of p.steps.entries()) {
      for (const b of Object.values(s.args)) {
        if (typeof b === "object" && b !== null && "kind" in b && b.kind === "from") {
          assert.ok(b.step < i, `step ${i} reads forward or out of range`);
        }
      }
    }
  }
});

/* ------------------------------------------------------------------ */

let n = 0;
const call = (traceId: string, seq: number, tool: string, args: Json, text: string): LabelledCall => ({
  traceId, seq, tsMs: n++, caller: "c", tool, args, goalId: "g", variant: "v",
  result: { content: [{ type: "text", text }], isError: false },
  isError: false, latencyMs: 1, resultBytes: text.length, resultTokens: 20,
});

/** Same outcome, reached after a different amount of looking around. */
function episode(id: string, exploreCalls: number): Episode & { calls: LabelledCall[] } {
  const calls: LabelledCall[] = [call(id, 0, "list", {}, '[{"n": "a"}, {"n": "b"}]')];
  for (let i = 0; i < exploreCalls; i++) {
    calls.push(call(id, calls.length, "describe", { of: `t${i}` }, `[{"col": "c${i}"}]`));
  }
  calls.push(call(id, calls.length, "fetch", { target: "the-one-file" }, "contents"));
  return { traceId: id, caller: "c", calls };
}

test("one goal explored different numbers of times becomes one route", () => {
  // Three callers looked around once, three looked around twice. Same outcome.
  const episodes = [
    episode("a1", 1), episode("a2", 1), episode("a3", 1),
    episode("b1", 2), episode("b2", 2), episode("b3", 2),
  ];
  const plans = detect(segment(episodes.flatMap((e) => e.calls)), {
    minSupport: 3, minLength: 2, maxLength: 8, config: readOnly("list", "describe", "fetch"),
  }).filter((c) => c.plan);

  assert.equal(plans.length, 1, "the two exploration depths should merge into a single route");
  const plan = plans[0]!.plan!;
  assert.equal(plans[0]!.score.support, 6, "and it should be backed by all six episodes");
  assert.deepEqual(plan.steps.map((s) => s.call), ["fetch"], "exploration calls are not executed");
});

test("a route that is just the upstream tool renamed is refused", () => {
  // Every caller fetches something unrelated, sharing not even a prefix, so
  // nothing can be baked in and the route would take exactly the argument the
  // tool itself takes. (Targets sharing a prefix would correctly produce a
  // template instead, which does carry knowledge and is not a passthrough.)
  const targets = ["alpha", "beta", "gamma", "delta"];
  const episodes = ["x", "y", "z", "w"].map((k, i) => ({
    traceId: k, caller: "c",
    calls: [
      call(k, 0, "list", {}, '[{"n": "a"}]'),
      call(k, 1, "fetch", { target: targets[i]! }, "contents"),
    ],
  }));
  const cands = detect(segment(episodes.flatMap((e) => e.calls)), {
    minSupport: 3, minLength: 2, maxLength: 8, config: readOnly("list", "fetch"),
  });
  assert.equal(cands.filter((c) => c.plan).length, 0);
  assert.match(cands[0]!.blockedBy ?? "", /upstream tool under another name/);
});
