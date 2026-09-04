import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRow, parseTrace, TraceFormatError, TRACE_VERSION } from "../src/trace/format.js";

const minimal = {
  traceId: "abc",
  seq: 0,
  tool: "list_things",
  args: {},
  result: { content: [{ type: "text", text: "[]" }] },
};

test("a hand-written row needs only the fields that cannot be derived", () => {
  const r = parseRow(minimal, "test");
  assert.equal(r.version, TRACE_VERSION);
  assert.equal(r.caller, "unknown");
  assert.equal(r.boundary, "process");
  assert.ok(r.resultTokens > 0, "token count is recomputed so nobody needs a tokenizer to write one");
  assert.ok(r.resultBytes > 0);
});

test("recorded sizes are trusted when both are present", () => {
  const r = parseRow({ ...minimal, resultBytes: 11, resultTokens: 7 }, "test");
  assert.equal(r.resultBytes, 11);
  assert.equal(r.resultTokens, 7);
});

test("every way a row can be wrong is rejected with its line number", () => {
  for (const [bad, why] of [
    [{ ...minimal, traceId: "" }, "empty traceId"],
    [{ ...minimal, traceId: undefined }, "missing traceId"],
    [{ ...minimal, tool: 5 }, "non-string tool"],
    [{ ...minimal, seq: -1 }, "negative seq"],
    [{ ...minimal, seq: 1.5 }, "fractional seq"],
    [{ ...minimal, args: undefined }, "missing args"],
    [{ ...minimal, result: undefined }, "missing result"],
    [{ ...minimal, boundary: "guessed" }, "unknown boundary"],
    [{ ...minimal, version: 99 }, "future version"],
    ["not an object", "not an object"],
  ] as const) {
    assert.throws(() => parseRow(bad, "test"), TraceFormatError, `should reject: ${why}`);
  }
});

test("a trace reports which line failed", () => {
  const text = [JSON.stringify(minimal), JSON.stringify({ ...minimal, tool: 1 })].join("\n");
  assert.throws(() => parseTrace(text, "f.jsonl"), /f\.jsonl:2/);
});

test("blank lines are skipped and an empty file is an error", () => {
  assert.equal(parseTrace(`\n${JSON.stringify(minimal)}\n\n`, "f").length, 1);
  assert.throws(() => parseTrace("\n\n", "f"), /no rows/);
});
