/**
 * What your traffic says about your server.
 *
 * Written for somebody who pointed this at a server we have never seen, so it
 * leads with what they can act on: which call sequences recur, what collapsing
 * them would save, and what is still blocking. The research-corpus numbers
 * only appear when the trace carries the ground-truth labels our own corpora
 * have, because "distinct goals" means nothing on real traffic.
 *
 * Nothing here is installed into anybody's server. This is a measurement.
 */
import { detect, loadCalls, optionsFor, segment } from "../detect/index.js";
import { select } from "../detect/select.js";
import { loadConfig } from "../config/load.js";
import { unclassifiedTools } from "../config/schema.js";
import { normalize } from "../detect/normalize.js";
import type { Candidate } from "../types.js";

const CORPUS = process.env["EMCP_CORPUS"] ?? "corpus/traces.jsonl";
const n = (x: number): string => x.toLocaleString("en-US");
const pct = (a: number, b: number): string => `${((a / Math.max(1, b)) * 100).toFixed(1)}%`;

const config = loadConfig();
const calls = loadCalls(CORPUS);
const episodes = segment(calls);
const candidates = detect(episodes, optionsFor(config));
const chosen = select(candidates);
const blocked = candidates.filter((c) => !c.plan);

const totalResultTokens = calls.reduce((a, c) => a + c.resultTokens, 0);
// A route returns its last call's result, so that payload reaches the caller
// either way and was never available to suppress.
const suppressible = episodes.reduce(
  (a, ep) => a + ep.calls.slice(0, -1).reduce((x, c) => x + c.resultTokens, 0),
  0,
);
const saved = chosen.reduce((a, s) => a + s.incrementalTokens, 0);
const schema = chosen.reduce((a, s) => a + s.candidate.score.schemaTokenCost, 0);
const prunedCalls = chosen.reduce((a, s) => a + s.candidate.score.upstreamCallsPruned * s.candidate.score.support, 0);
const covered = new Set<string>();
for (const s of chosen) for (const m of s.candidate.cluster.members) covered.add(m.episode.traceId);

const boundaries = new Map<string, number>();
for (const c of calls as Array<{ boundary?: string }>) {
  const b = c.boundary ?? "unknown";
  boundaries.set(b, (boundaries.get(b) ?? 0) + 1);
}
const structured = calls.filter((c) => normalize(c.result).normalizer === "structured").length;

console.log(`# What your traffic says about your server

## Recorded
  episodes                 ${n(episodes.length)}
  calls                    ${n(calls.length)}
  distinct tools used      ${new Set(calls.map((c) => c.tool)).size}
  distinct callers         ${new Set(calls.map((c) => c.caller)).size}
  result tokens seen       ${n(totalResultTokens)}
  of which suppressible    ${n(suppressible)}  (${pct(suppressible, totalResultTokens)}; the rest is the answer the caller keeps)
  episode boundaries from  ${[...boundaries].map(([k, v]) => `${k}=${v}`).join(", ")}
  structured results       ${structured} of ${calls.length}${structured === 0 ? "  (dataflow had to be read out of text blobs)" : ""}`);

/* ---------------- configuration ---------------- */
console.log(`\n## Configuration`);
if (!config) {
  console.log(`  No config found. Every tool is therefore treated as mutating, which means
  no route will skip any call, and most of the saving is unavailable.

  Run \`evolving-mcp init -- <your server command>\` to generate one.`);
} else {
  const todo = unclassifiedTools(config);
  const known = Object.keys(config.tools).length;
  const unseen = [...new Set(calls.map((c) => c.tool))].filter((t) => !config.tools[t]).sort();
  console.log(`  ${known} tools configured, ${known - todo.length} classified`);
  if (todo.length) {
    console.log(`\n  ${todo.length} unclassified, so no route will skip them:`);
    for (const t of todo) console.log(`    ${t}`);
  }
  if (unseen.length) {
    console.log(`\n  ${unseen.length} tools appear in the trace but not in the config. Re-run \`init\`:`);
    for (const t of unseen) console.log(`    ${t}`);
  }
}

/* ---------------- routes ---------------- */
console.log(`\n## Routes your traffic would produce (${chosen.length})\n`);
if (!chosen.length) {
  console.log(`  None yet.`);
  const opts = optionsFor(config);
  if (episodes.length < opts.minSupport) {
    console.log(`
  Only ${episodes.length} episode${episodes.length === 1 ? " was" : "s were"} recorded, and a sequence has to recur
  ${opts.minSupport} times before it is worth promoting. Record more traffic.

  Episodes are split by trace context when your client sends one, and otherwise
  by a gap in time. A script firing calls back to back looks like one long
  episode, which is why an automated run often produces exactly one.`);
  } else if (blocked.length) {
    console.log(`\n  ${blocked.length} sequence${blocked.length === 1 ? "" : "s"} recurred but could not be turned into a route. See below.`);
  }
} else {
  for (const s of chosen) {
    const p = s.candidate.plan!;
    const params = Object.keys((p.inputSchema["properties"] ?? {}) as object);
    console.log(`  ${p.name}`);
    console.log(`      seen in ${s.candidate.score.support} episodes, replaces ${s.candidate.score.support ? p.steps.length + s.candidate.score.upstreamCallsPruned : 0} calls with ${p.steps.length}`);
    console.log(`      keeps ${n(s.incrementalTokens)} tokens out of context, costs ${n(s.candidate.score.schemaTokenCost)} in tool schema`);
    console.log(`      inputs: ${params.length ? params.join(", ") : "none"}${s.candidate.score.mutating ? "   CONTAINS A MUTATING OR UNCLASSIFIED CALL" : ""}`);
    console.log("");
  }
}

/* ---------------- blocked ---------------- */
if (blocked.length) {
  console.log(`## Recurring sequences that could not become routes (${blocked.length})\n`);
  for (const c of blocked.slice(0, 8)) {
    console.log(`  ${c.cluster.shape.tools.join(" > ")}  (${c.score.support} episodes)`);
    console.log(`      ${c.blockedBy}\n`);
  }
}

/* ---------------- totals ---------------- */
console.log(`\n## If you promoted all of them
  episodes with a route                 ${n(covered.size)} of ${n(episodes.length)}  (${pct(covered.size, episodes.length)})
  tokens kept out of context            ${n(saved)}
  share of what was ever suppressible   ${pct(saved, suppressible)}
  upstream calls never made             ${n(prunedCalls)}
  tool schema added to every tools/list  ${n(schema)}${schema > 0 ? `\n  paid back after                       ${(saved / schema).toFixed(1)} passes over this traffic` : ""}`);

/* ---------------- research corpora only ---------------- */
const labelled = episodes.filter((e) => e.goalId).length;
if (labelled) {
  const goals = new Set(episodes.map((e) => e.goalId).filter(Boolean));
  const impure = candidates.filter((c) => new Set(c.cluster.members.map((m) => m.episode.goalId)).size > 1).length;
  console.log(`\n## Ground truth (this trace carries goal labels)
  distinct goals                 ${goals.size}
  clusters spanning >1 goal      ${impure}   (0 means nothing merged two different intents)`);
}
