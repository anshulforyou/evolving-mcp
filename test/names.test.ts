import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, loadCalls, segment } from "../src/detect/index.js";

/** The rules from the MCP 2026-07-28 tools spec. */
const VALID = /^[A-Za-z0-9_.-]{1,128}$/;

const candidates = detect(segment(loadCalls("corpus/traces.jsonl")));
const plans = candidates.map((c) => c.plan).filter((p): p is NonNullable<typeof p> => !!p);

test("the corpus produces routes at all", () => {
  assert.ok(plans.length > 0, "no plans built, the rest of these assertions would be vacuous");
});

test("every generated name satisfies the MCP tool name rules", () => {
  for (const p of plans) {
    assert.match(p.name, VALID, `invalid tool name: ${p.name}`);
    assert.ok(p.name.length <= 128);
  }
});

test("names are unique within the server, which MCP requires", () => {
  const names = plans.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "duplicate route names would collide on tools/list");
});

test("every plan returns a step it actually has", () => {
  for (const p of plans) {
    assert.ok(p.returns >= 0 && p.returns < p.steps.length);
  }
});

test("every param a plan declares is one its steps actually use", () => {
  for (const p of plans) {
    const declared = Object.keys((p.inputSchema["properties"] ?? {}) as Record<string, unknown>);
    const used = new Set<string>();
    const walk = (t: unknown): void => {
      if (Array.isArray(t)) return t.forEach(walk);
      if (t && typeof t === "object") {
        const k = (t as { kind?: string }).kind;
        if (k === "param") used.add((t as { name: string }).name);
        else if (k === "template") (t as { parts: unknown[] }).parts.forEach(walk);
        else if (!k) Object.values(t).forEach(walk);
      }
    };
    for (const s of p.steps) walk(s.args);
    assert.deepEqual([...declared].sort(), [...used].sort(), `schema and bindings disagree in ${p.name}`);
  }
});
