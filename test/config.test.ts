import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, isMutating, normalizerFor, parseConfig, unclassifiedTools } from "../src/config/schema.js";

const ok = (tools: object) => parseConfig({ version: 1, tools }, "test");

test("with no config at all, every tool is treated as mutating", () => {
  // The safe default. Pruning decides which calls a route SKIPS, and skipping
  // something with a side effect is the worst thing this system can do.
  assert.equal(isMutating(undefined, "anything"), true);
});

test("an unclassified tool is treated exactly as a mutating one", () => {
  const c = ok({ t: { mutability: "unclassified" } });
  assert.equal(isMutating(c, "t"), true);
  assert.deepEqual(unclassifiedTools(c), ["t"]);
});

test("a tool the config has never heard of is treated as mutating", () => {
  assert.equal(isMutating(ok({ known: { mutability: "read-only" } }), "unknown"), true);
});

test("only an explicit read-only classification permits skipping", () => {
  assert.equal(isMutating(ok({ t: { mutability: "read-only" } }), "t"), false);
});

test("a malformed config throws rather than falling back to defaults", () => {
  // Silently defaulting would turn a typo into a disabled safety rule.
  for (const bad of [
    { version: 2, tools: {} },
    { version: 1 },
    { version: 1, tools: { t: { mutability: "readonly" } } },
    { version: 1, tools: { t: {} } },
    { version: 1, tools: { t: { mutability: "read-only", normalizers: { "$.q": "sqlite" } } } },
    { version: 1, tools: { t: { mutability: "read-only", normalizers: { q: "sql" } } } },
    { version: 1, tools: {}, mining: { minSupport: 0 } },
    { version: 1, tools: {}, server: { command: "x" } },
  ]) {
    assert.throws(() => parseConfig(bad, "test"), ConfigError, `should have rejected ${JSON.stringify(bad)}`);
  }
});

test("a normalizer is looked up by tool and argument path", () => {
  const c = ok({ read_query: { mutability: "read-only", normalizers: { "$.query": "sql" } } });
  assert.equal(normalizerFor(c, "read_query", "$.query"), "sql");
  assert.equal(normalizerFor(c, "read_query", "$.other"), undefined);
  assert.equal(normalizerFor(c, "other_tool", "$.query"), undefined);
});
