import { test } from "node:test";
import assert from "node:assert/strict";
import { isComposed, shapeOf, skeleton } from "../src/detect/canon.js";
import type { Json, RecordedCall } from "../src/types.js";

const call = (tool: string, args: Json): RecordedCall => ({
  traceId: "t", seq: 0, tsMs: 0, caller: "c", tool, args, result: null,
  isError: false, latencyMs: 0, resultBytes: 0, resultTokens: 0,
});

test("runs differing only in values collapse to one shape", () => {
  const a = shapeOf([call("list", {}), call("get", { id: 1 })]);
  const b = shapeOf([call("list", {}), call("get", { id: 999 })]);
  assert.equal(a.key, b.key);
});

test("argument key order cannot change the shape", () => {
  const a = shapeOf([call("f", { alpha: 1, beta: 2 })]);
  const b = shapeOf([call("f", { beta: 2, alpha: 1 })]);
  assert.equal(a.key, b.key);
});

test("the same query with different literals shares a skeleton", () => {
  assert.equal(
    skeleton("SELECT a FROM t WHERE id = 12 AND name = 'ana'"),
    skeleton("SELECT a FROM t WHERE id = 7 AND name = 'bo'"),
  );
});

test("a structurally different query does not share a skeleton", () => {
  assert.notEqual(
    skeleton("SELECT a FROM t WHERE id = 12"),
    skeleton("SELECT a, b FROM t GROUP BY a"),
  );
});

test("composed strings keep queries apart that tool names alone would merge", () => {
  // This is the defect the first detector run had: read_query is always
  // {query: string}, so on tool names alone every question collapses into one
  // cluster and nothing can be templated.
  const a = shapeOf([call("read_query", { query: "SELECT total FROM invoices WHERE customer_id = 1" })]);
  const b = shapeOf([call("read_query", { query: "SELECT count(*) FROM tracks GROUP BY genre_id" })]);
  assert.notEqual(a.key, b.key);
});

test("short scalars stay values, not shape", () => {
  const a = shapeOf([call("describe_table", { table_name: "customers" })]);
  const b = shapeOf([call("describe_table", { table_name: "invoices" })]);
  assert.equal(a.key, b.key, "a table name is a value the next stage classifies");
});

test("composedness, not length, decides whether a string is part of the shape", () => {
  // This was a length test once. Absolute paths cleared the bar and were
  // silently carrying each goal's identity; portable paths did not, and
  // coverage fell from 97% to 57% with nothing else changed.
  assert.equal(isComposed("customers"), false, "an atomic value is not shape");
  assert.equal(isComposed("{TREE}/src/db/pool.js"), true, "a path is composed");
  assert.equal(isComposed("SELECT a FROM t"), true, "a query is composed");
  assert.equal(isComposed("a".repeat(200)), false, "length alone means nothing");
});
