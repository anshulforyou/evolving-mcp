/**
 * How much of a corpus does a route surface cover when the intent is NEW?
 *
 * Every held-out test so far splits episodes at random, so every goal appears
 * in both halves. That measures whether a route generalizes across phrasings
 * and exploration paths of a question the miner has already seen. It says
 * nothing about the long tail, and real traffic is mostly long tail.
 *
 * This holds out whole GOALS. Routes mined from the rest are then asked to
 * cover episodes of an intent that never appeared in training.
 */
import { detect, loadCalls, optionsFor, segment } from "../detect/index.js";
import { select } from "../detect/select.js";
import { shapeOf } from "../detect/canon.js";
import { loadConfig } from "../config/load.js";
import type { Episode } from "../types.js";

const CORPUS = process.env.EMCP_CORPUS ?? "corpus/traces-fs.jsonl";
const config = loadConfig(process.env.EMCP_CONFIG ?? "corpus/config.fs.json");
const eps = segment(loadCalls(CORPUS));
const goals = [...new Set(eps.map((e) => e.goalId!))].sort();

const coverage = (train: Episode[], test: Episode[]) => {
  const chosen = select(detect(train, optionsFor(config)));
  const shapes = new Set<string>();
  for (const s of chosen) for (const m of s.candidate.cluster.members) {
    shapes.add(shapeOf(m.episode.calls.slice(m.start, m.end), config).key);
  }
  let matched = 0, tokens = 0, saved = 0;
  for (const ep of test) {
    tokens += ep.calls.slice(0, -1).reduce((a, c) => a + c.resultTokens, 0);
    for (let s = 0; s < ep.calls.length; s++) {
      if (shapes.has(shapeOf(ep.calls.slice(s), config).key)) {
        matched++;
        saved += ep.calls.slice(s, -1).reduce((a, c) => a + c.resultTokens, 0);
        break;
      }
    }
  }
  return { routes: chosen.length, matched, of: test.length, saved, tokens };
};

console.log(`${CORPUS}: ${eps.length} episodes, ${goals.length} goals\n`);

// 1. Episode holdout, the optimistic split every earlier test used.
const byHash = (e: Episode) => [...e.traceId].reduce((a, c) => a + c.charCodeAt(0), 0) % 10;
const epTrain = eps.filter((e) => byHash(e) < 7);
const epTest = eps.filter((e) => byHash(e) >= 7);
const a = coverage(epTrain, epTest);
console.log(`episode holdout   train ${epTrain.length}  test ${epTest.length}`);
console.log(`   ${a.routes} routes, covered ${a.matched}/${a.of} episodes (${((a.matched / a.of) * 100).toFixed(0)}%), suppressed ${((a.saved / Math.max(1, a.tokens)) * 100).toFixed(1)}% of held-out suppressible\n`);

// 2. Leave-one-goal-out, averaged. The intent is new every time.
let m = 0, of = 0, sv = 0, tk = 0, rt = 0;
for (const g of goals) {
  const r = coverage(eps.filter((e) => e.goalId !== g), eps.filter((e) => e.goalId === g));
  m += r.matched; of += r.of; sv += r.saved; tk += r.tokens; rt += r.routes;
}
console.log(`leave-one-goal-out  (${goals.length} folds, the intent is unseen every time)`);
console.log(`   ${(rt / goals.length).toFixed(1)} routes on average, covered ${m}/${of} episodes (${((m / of) * 100).toFixed(0)}%), suppressed ${((sv / Math.max(1, tk)) * 100).toFixed(1)}%`);
