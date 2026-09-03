import { loadCalls, segment } from "./segment.js";
import { mine, DEFAULTS, type MineOptions } from "./mine.js";
import { analyze, resetParamNames } from "./dataflow.js";
import { synthesize } from "./synth.js";
import { score } from "./score.js";
import type { Candidate, Episode } from "../types.js";

export function detect(episodes: Episode[], opts: MineOptions = DEFAULTS): Candidate[] {
  resetParamNames();
  const clusters = mine(episodes, opts);
  const out: Candidate[] = [];
  for (const cluster of clusters) {
    const analyses = analyze(cluster);
    const { plan, blockedBy } = synthesize(cluster, analyses);
    out.push({
      cluster,
      analyses,
      ...(plan ? { plan } : {}),
      ...(blockedBy ? { blockedBy } : {}),
      score: score(cluster, analyses, plan),
    });
  }
  out.sort((a, b) => b.score.intermediateTokensSaved - a.score.intermediateTokensSaved);
  return out;
}

export { loadCalls, segment, mine, analyze, synthesize, score, DEFAULTS };
export type { MineOptions };
