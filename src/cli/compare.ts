/**
 * One table across every corpus, because the whole argument of this repo is a
 * comparison rather than a single number.
 */
import { detect, loadCalls, optionsFor, segment } from "../detect/index.js";
import { loadConfig } from "../config/load.js";
import { select } from "../detect/select.js";
import { schemaTokenCost } from "../metrics/tokens.js";

const CORPORA: Array<{ label: string; path: string; who: string; config: string }> = [
  { label: "sqlite", path: "corpus/traces.jsonl", who: "queries written by hand", config: "corpus/config.sqlite.json" },
  { label: "sqlite", path: "corpus/traces-llm.jsonl", who: "queries written by a model", config: "corpus/config.sqlite.json" },
  { label: "filesystem", path: "corpus/traces-fs.jsonl", who: "targets chosen by a model", config: "corpus/config.fs.json" },
];

const pct = (a: number, b: number): string => `${((a / Math.max(1, b)) * 100).toFixed(1)}%`;

console.log(
  `${"server".padEnd(11)} ${"who writes the arguments".padEnd(26)} ${"eps".padStart(4)} ` +
    `${"routes".padStart(6)} ${"ep cov".padStart(7)} ${"suppressible".padStart(13)} ${"of that, saved".padStart(15)}`,
);
console.log("-".repeat(90));

for (const c of CORPORA) {
  const config = loadConfig(c.config);
  const episodes = segment(loadCalls(c.path));
  const calls = episodes.flatMap((e) => e.calls);
  const chosen = select(detect(episodes, optionsFor(config)));

  const total = calls.reduce((a, x) => a + x.resultTokens, 0);
  const suppressible = episodes.reduce(
    (a, ep) => a + ep.calls.slice(0, -1).reduce((x, k) => x + k.resultTokens, 0),
    0,
  );
  const saved = chosen.reduce((a, s) => a + s.incrementalTokens, 0);
  const covered = new Set<string>();
  for (const s of chosen) for (const m of s.candidate.cluster.members) covered.add(m.episode.traceId);
  const schema = chosen.reduce((a, s) => a + schemaTokenCost(s.candidate.plan!), 0);
  // Styles are named per goal, so counting them across the corpus overcounts.
  // What matters is how many ways a single goal was explored.
  const perGoal = new Map<string, Set<string>>();
  for (const e of episodes) {
    const g = e.goalId ?? "?";
    (perGoal.get(g) ?? perGoal.set(g, new Set()).get(g)!).add((e.variant ?? "").split("|")[0]!);
  }
  const stylesPerGoal = Math.max(1, ...[...perGoal.values()].map((v) => v.size));
  const pruned = chosen.reduce((a, s) => a + s.candidate.score.upstreamCallsPruned * s.candidate.score.support, 0);

  console.log(
    `${c.label.padEnd(11)} ${c.who.padEnd(26)} ${String(episodes.length).padStart(4)} ` +
      `${String(chosen.length).padStart(6)} ${pct(covered.size, episodes.length).padStart(7)} ` +
      `${(pct(suppressible, total) + " of " + total.toLocaleString()).padStart(13)} ${pct(saved, suppressible).padStart(15)}` +
      `   ${stylesPerGoal} explorations/goal, ${pruned} calls pruned, schema +${schema} tok`,
  );
}

console.log(`
"suppressible" is the share of result tokens a route could ever keep out of a
model's context. The final call's result is what the caller asked for and goes
back either way, so it is never available to suppress. Measuring against every
result token instead makes a server look worse the larger its answers are,
which is why the sqlite figures collapse once a model stops writing LIMIT.`);
