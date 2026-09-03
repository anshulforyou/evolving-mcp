import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { detect, loadCalls, segment } from "../src/detect/index.js";
import { select } from "../src/detect/select.js";

/**
 * The test that matters publicly.
 *
 * The corpus is committed, so anyone can clone this repo and check that the
 * routes claimed in the findings are the routes the detector actually produces
 * from that data. It only works because a route is data run by a fixed
 * interpreter rather than generated code, which is the whole argument for that
 * choice.
 *
 * Regenerate deliberately with EMCP_UPDATE_GOLDEN=1, and the diff is then the
 * thing to review.
 */
const GOLDEN = "test/golden.routes.json";

const chosen = select(detect(segment(loadCalls("corpus/traces.jsonl"))));
const actual = chosen.map((s) => ({
  name: s.candidate.plan!.name,
  steps: s.candidate.plan!.steps.map((x) => x.call),
  params: Object.keys((s.candidate.plan!.inputSchema["properties"] ?? {}) as Record<string, unknown>).sort(),
  support: s.candidate.score.support,
  incrementalTokens: s.incrementalTokens,
  schemaTokenCost: s.candidate.score.schemaTokenCost,
}));

test("the committed corpus produces exactly the recorded set of routes", () => {
  if (process.env["EMCP_UPDATE_GOLDEN"] === "1" || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
    console.log(`wrote ${GOLDEN} (${actual.length} routes)`);
    return;
  }
  const expected = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof actual;
  assert.deepEqual(actual, expected);
});

test("detection is deterministic across repeated runs", () => {
  const again = select(detect(segment(loadCalls("corpus/traces.jsonl")))).map((s) => s.candidate.plan!.name);
  assert.deepEqual(again, chosen.map((s) => s.candidate.plan!.name));
});
