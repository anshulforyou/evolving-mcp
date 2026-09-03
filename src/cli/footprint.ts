/**
 * Does a semantic footprint actually normalize better than lexical matching,
 * and does it over-merge?
 *
 * Both questions are answerable without a model, because every episode in the
 * corpus carries a `goalId` recording what the caller was really trying to do.
 * That label is never an input to the detector. It exists exactly so a cluster
 * can be checked against intent rather than against itself.
 *
 *   merge   mean distinct keys per goal. 1.00 means every phrasing of a
 *           question collapsed to one thing, which is the aim.
 *   purity  share of keys that belong to exactly one goal. Below 1.00 means
 *           the normalizer merged questions that are not the same question,
 *           and each of those is a place a promotion-time check has to catch.
 */
import { loadCalls, segment } from "../detect/index.js";
import { skeleton } from "../detect/canon.js";
import { footprintKey } from "../detect/footprint.js";

const CORPUS = process.env["EMCP_CORPUS"] ?? "corpus/traces-llm.jsonl";
const MIN_SUPPORT = Number(process.env["EMCP_SUPPORT"] ?? 3);

const queries: Array<{ goal: string; sql: string }> = [];
for (const ep of segment(loadCalls(CORPUS))) {
  for (const c of ep.calls) {
    if (c.tool !== "read_query") continue;
    queries.push({ goal: ep.goalId!, sql: String((c.args as { query: string }).query) });
  }
}

const NORMALIZERS: Array<{ name: string; fn: (s: string) => string }> = [
  { name: "raw string", fn: (s) => s },
  { name: "skeleton (literals masked)", fn: (s) => skeleton(s, { aliases: false }) },
  { name: "skeleton + alias renaming", fn: (s) => skeleton(s) },
  { name: "footprint strict", fn: (s) => footprintKey(s, "strict") ?? `UNPARSED:${s}` },
  { name: "footprint loose", fn: (s) => footprintKey(s, "loose") ?? `UNPARSED:${s}` },
];

const goals = [...new Set(queries.map((q) => q.goal))];
console.log(`corpus ${CORPUS}: ${queries.length} queries across ${goals.length} goals\n`);
console.log(
  `${"normalizer".padEnd(28)} ${"keys".padStart(5)} ${"merge".padStart(6)} ${"purity".padStart(7)} ` +
    `${"goals reaching support " + MIN_SUPPORT}`,
);
console.log("-".repeat(84));

const collisions: Record<string, string[][]> = {};

for (const norm of NORMALIZERS) {
  const keyed = queries.map((q) => ({ ...q, key: norm.fn(q.sql) }));
  const allKeys = new Set(keyed.map((k) => k.key));

  // merge: how many distinct keys each goal still splits into
  const perGoal = goals.map((g) => new Set(keyed.filter((k) => k.goal === g).map((k) => k.key)).size);
  const merge = perGoal.reduce((a, b) => a + b, 0) / goals.length;

  // purity: keys owned by exactly one goal
  const byKey = new Map<string, Set<string>>();
  for (const k of keyed) (byKey.get(k.key) ?? byKey.set(k.key, new Set()).get(k.key)!).add(k.goal);
  const impure = [...byKey.entries()].filter(([, gs]) => gs.size > 1);
  const purity = 1 - impure.length / allKeys.size;
  collisions[norm.name] = impure.map(([, gs]) => [...gs]);

  // how many goals get a cluster big enough to promote
  const reaching = goals.filter((g) => {
    const counts = new Map<string, number>();
    for (const k of keyed) if (k.goal === g) counts.set(k.key, (counts.get(k.key) ?? 0) + 1);
    return Math.max(0, ...counts.values()) >= MIN_SUPPORT;
  }).length;

  console.log(
    `${norm.name.padEnd(28)} ${String(allKeys.size).padStart(5)} ${merge.toFixed(2).padStart(6)} ` +
      `${purity.toFixed(2).padStart(7)}   ${reaching} of ${goals.length}`,
  );
}

// What is still split under the strongest setting, and why it matters
console.log(`\n## Still split under footprint loose`);
{
  const keyed = queries.map((q) => ({ ...q, key: footprintKey(q.sql, "loose") ?? `UNPARSED:${q.sql}` }));
  for (const g of goals) {
    const ks = new Map<string, number>();
    for (const k of keyed) if (k.goal === g) ks.set(k.key, (ks.get(k.key) ?? 0) + 1);
    if (ks.size <= 1) continue;
    console.log(`  ${g}: ${ks.size} footprints, counts ${[...ks.values()].sort((a, b) => b - a).join("/")}`);
    for (const key of ks.keys()) {
      const ex = keyed.find((k) => k.goal === g && k.key === key)!;
      console.log(`      ${ex.sql.replace(/\s+/g, " ").slice(0, 96)}`);
    }
  }
}

console.log(`\n## Where a normalizer merged two different goals`);
let any = false;
for (const [name, pairs] of Object.entries(collisions)) {
  if (!pairs.length) continue;
  any = true;
  console.log(`  ${name}:`);
  for (const p of pairs) console.log(`      ${p.join("  +  ")}`);
}
if (!any) console.log("  none, at any strength tested");
