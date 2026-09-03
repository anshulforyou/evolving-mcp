import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverParams, runRoute, unifyTemplate } from "../src/detect/interpret.js";
import type { CallSink } from "../src/detect/interpret.js";
import type { Json, RoutePlan } from "../src/types.js";

const text = (s: string): Json => ({ content: [{ type: "text", text: s }], isError: false });

class MockServer implements CallSink {
  calls: Array<{ name: string; args: Json }> = [];
  constructor(private readonly handler: (name: string, args: Json) => Json) {}
  callTool(name: string, args: Json): Promise<Json> {
    this.calls.push({ name, args });
    return Promise.resolve(this.handler(name, args));
  }
}

const PLAN: RoutePlan = {
  name: "find_then_fetch.abc123",
  description: "d",
  inputSchema: { type: "object", properties: { who: { type: "string" } } },
  steps: [
    { call: "find", args: { q: { kind: "template", parts: ["name = ", { kind: "param", name: "who" }] } } },
    { call: "fetch", args: { id: { kind: "from", step: 0, path: "$[0].id" } } },
  ],
  returns: 1,
};

test("a plan runs, threading a value from one step into the next", async () => {
  const srv = new MockServer((name) => (name === "find" ? text('[{"id": 42}]') : text("record 42")));
  const { result } = await runRoute(PLAN, { who: "ana" }, srv);
  assert.deepEqual(srv.calls[0], { name: "find", args: { q: "name = ana" } });
  assert.deepEqual(srv.calls[1], { name: "fetch", args: { id: 42 } });
  assert.deepEqual(result, text("record 42"));
});

test("a step failing partway through surfaces rather than returning a partial answer", async () => {
  const srv = new MockServer((name) => {
    if (name === "find") throw new Error("upstream down");
    return text("never reached");
  });
  await assert.rejects(() => runRoute(PLAN, { who: "ana" }, srv), /upstream down/);
});

test("a binding that cannot be resolved is an error, not a silent empty argument", async () => {
  const srv = new MockServer(() => text("[]")); // no rows, so $[0].id is absent
  await assert.rejects(() => runRoute(PLAN, { who: "ana" }, srv), /no value at/);
});

test("a missing param is refused rather than sent as undefined", async () => {
  const srv = new MockServer(() => text('[{"id": 1}]'));
  await assert.rejects(() => runRoute(PLAN, {}, srv), /missing param who/);
});

test("params are recovered from a real call's arguments", () => {
  const got = recoverParams(PLAN, [{ q: "name = ana" }, { id: 42 }]);
  assert.deepEqual(got, { who: "ana" });
});

test("unify refuses a string the template does not actually fit", () => {
  assert.equal(unifyTemplate(["a = ", { kind: "param", name: "x" }], "b = 1"), null);
});

test("a template rebuilds the exact string it was extracted from", () => {
  const parts = ["SELECT * FROM t WHERE id = ", { kind: "param" as const, name: "id" }, " ORDER BY x"];
  const recovered = unifyTemplate(parts, "SELECT * FROM t WHERE id = 99 ORDER BY x");
  assert.deepEqual(recovered, { id: "99" });
});
