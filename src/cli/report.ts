/**
 * Phase 0 report. Everything here is computed, nothing is asserted by hand.
 */
import { detect, loadCalls, optionsFor, segment } from "../detect/index.js";
import { loadConfig } from "../config/load.js";
import { select } from "../detect/select.js";
import { normalize } from "../detect/normalize.js";
import type { Candidate } from "../types.js";

const CORPUS = process.env["EMCP_CORPUS"] ?? "corpus/traces.jsonl";
const n = (x: number): string => x.toLocaleString("en-US");

const config = loadConfig();
const calls = loadCalls(CORPUS);
const episodes = segment(calls);
const candidates = detect(episodes, optionsFor(config));

const promotable = candidates.filter((c) => c.plan);
const blocked = candidates.filter((c) => !c.plan);
const worthIt = promotable.filter((c) => c.score.payoffRatio > 1 && c.score.intermediateTokensSaved > 0);

/* ---------------- corpus ---------------- */
const norms = calls.map((c) => normalize(c.result).normalizer);
const normCount = new Map<string, number>();
for (const nm of norms) normCount.set(nm, (normCount.get(nm) ?? 0) + 1);
const totalResultTokens = calls.reduce((a, c) => a + c.resultTokens, 0);

// A route returns its last call's result, so that payload reaches the caller
// either way and was never available to suppress. Measuring against every
// result token understates the work by counting an unreachable denominator.
// On this server the final read_query dominates, so the two differ a lot.
const suppressibleTokens = episodes.reduce(
  (a, ep) => a + ep.calls.slice(0, -1).reduce((x, c) => x + c.resultTokens, 0),
  0,
);

/* ---------------- selection and coverage ---------------- */
const chosen = select(candidates);
const promotedTraces = new Set<string>();
for (const s of chosen) for (const m of s.candidate.cluster.members) promotedTraces.add(m.episode.traceId);
const absorbedCalls = chosen.reduce((a, s) => a + s.incrementalCalls, 0);
const uniqueNames = new Set(promotable.map((c) => c.plan!.name));

console.log(`# evolving-mcp phase 0

## Corpus
  episodes                 ${n(episodes.length)}
  calls                    ${n(calls.length)}
  distinct callers         ${new Set(calls.map((c) => c.caller)).size}
  distinct goals           ${new Set(calls.map((c) => c.goalId)).size}
  result tokens total      ${n(totalResultTokens)}
  of which suppressible    ${n(suppressibleTokens)}  (${((suppressibleTokens / totalResultTokens) * 100).toFixed(0)}%, the rest is the answer the caller keeps)
  mean tokens per episode  ${n(Math.round(totalResultTokens / episodes.length))}
  normalizer used          ${[...normCount].map(([k, v]) => `${k}=${v}`).join(", ")}

Note: no call in this corpus carried structuredContent. Every derivation had to
run over a reconstruction of a Python repr in a text block, which is what real
servers emit today.

## Detection
  clusters at support>=3   ${n(candidates.length)}
  plans built (recipe)     ${n(promotable.length)}
  blocked, no plan         ${n(blocked.length)}
  net-positive routes      ${n(worthIt.length)}
  upstream calls pruned    ${n(chosen.reduce((a, s) => a + s.candidate.score.upstreamCallsPruned * s.candidate.score.support, 0))} across the corpus (calls a route never makes)
  routes actually selected ${n(chosen.length)}   (non-overlapping, greedy)
  route names unique       ${uniqueNames.size === promotable.length ? "yes" : `NO (${promotable.length - uniqueNames.size} collisions)`}

  episodes with a route    ${n(promotedTraces.size)} of ${n(episodes.length)}  (${((promotedTraces.size / episodes.length) * 100).toFixed(0)}%)
  calls a route absorbs    ${n(absorbedCalls)} of ${n(calls.length)}  (${((absorbedCalls / calls.length) * 100).toFixed(0)}%)

Straight-line fraction is deliberately NOT reported. Once canonicalization
includes a string skeleton, cluster members share token structure by
construction, so templating cannot fail and the number would be 100% whatever
the data said. Episode and call coverage are reported instead, because those
still measure something.`);

/* ---------------- routes ---------------- */
const row = (c: Candidate): string => {
  const s = c.score;
  const params = c.plan ? Object.keys((c.plan.inputSchema["properties"] ?? {}) as object) : [];
  return [
    `  ${c.plan!.name}`,
    `      support ${s.support}  saves ${n(s.intermediateTokensSaved)} tok/use  (raw ${n(s.rawIntermediateTokensSaved)})`,
    `      schema cost ${n(s.schemaTokenCost)} tok  payoff x${s.payoffRatio}  round trips saved ${s.roundTripsSaved}`,
    `      params [${params.join(", ") || "none"}]${s.mutating ? "  MUTATING" : ""}`,
  ].join("\n");
};

console.log(`\n## Routes worth promoting (payoff > 1)\n`);
if (!worthIt.length) console.log("  none");
for (const c of worthIt.slice(0, 12)) console.log(row(c) + "\n");

const deadWeight = promotable.filter((c) => !worthIt.includes(c));
console.log(`## Plans built but not worth promoting (${deadWeight.length})\n`);
for (const c of deadWeight.slice(0, 8)) {
  const d = c.analyses.filter((a) => a.discoveredIn !== undefined);
  console.log(
    `  ${c.plan!.name}\n      saves ${n(c.score.intermediateTokensSaved)} of ${n(c.score.rawIntermediateTokensSaved)} raw, payoff x${c.score.payoffRatio}` +
      (d.length ? `\n      discovered params: ${d.map((a) => `${a.argPath}@step${a.discoveredIn}`).join(", ")}` : ""),
  );
}

/* ---------------- primitive gap ---------------- */
console.log(`\n## Primitive gap`);
const gapNotes = candidates
  .flatMap((c) => c.analyses)
  .filter((a) => a.discoveredIn !== undefined || a.role === "unstable")
  .map((a) => a.note ?? "unstable")
  .filter(Boolean);
const gapTally = new Map<string, number>();
for (const g of gapNotes) {
  const key = g.replace(/step \d+/g, "step N").replace(/hole \d+/g, "hole N");
  gapTally.set(key, (gapTally.get(key) ?? 0) + 1);
}
if (!gapTally.size) console.log("  none");
for (const [k, v] of [...gapTally].sort((a, b) => b[1] - a[1])) console.log(`  x${v}  ${k}`);

/* ---------------- blocked ---------------- */
console.log(`\n## Blocked clusters (${blocked.length})`);
for (const c of blocked.slice(0, 6)) {
  console.log(`  ${c.cluster.shape.tools.join(" > ")}  (support ${c.score.support})\n      ${c.blockedBy}`);
}

/* ---------------- selected set ---------------- */
console.log(`\n## The set a server would actually promote (${chosen.length})\n`);
for (const s of chosen) {
  const p = s.candidate.plan!;
  console.log(
    `  ${p.name}\n` +
      `      suppresses ${n(s.incrementalTokens)} tok across ${n(s.incrementalCalls)} calls, schema ${n(s.candidate.score.schemaTokenCost)} tok\n` +
      `      runs ${p.steps.length} upstream call(s), skipping ${s.candidate.score.upstreamCallsPruned} it never needed to make`,
  );
}

/* ---------------- totals ---------------- */
const totalSaved = chosen.reduce((a, s) => a + s.incrementalTokens, 0);
const totalSchema = chosen.reduce((a, s) => a + s.candidate.score.schemaTokenCost, 0);
console.log(`\n## Totals over this corpus, counted once
  result tokens recorded                          ${n(totalResultTokens)}
  of which a route could ever suppress            ${n(suppressibleTokens)}
  tokens the selected routes keep out of context  ${n(totalSaved)}
  share of suppressible tokens (the real figure)  ${((totalSaved / Math.max(1, suppressibleTokens)) * 100).toFixed(1)}%
  share of all result tokens                      ${((totalSaved / totalResultTokens) * 100).toFixed(1)}%
  schema tokens added to every tools/list         ${n(totalSchema)}
  one full corpus pass pays the schema back       ${totalSchema > 0 ? (totalSaved / totalSchema).toFixed(1) : "n/a"}x`);
