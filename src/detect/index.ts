import { loadCalls, segment } from "./segment.js";
import { mine, DEFAULTS, type MineOptions } from "./mine.js";
import { analyze, resetParamNames } from "./dataflow.js";
import { synthesize } from "./synth.js";
import { score } from "./score.js";
import type { Config } from "../config/schema.js";
import type { Candidate, Cluster, Episode } from "../types.js";

/**
 * Clustering and execution are different questions, and conflating them cost a
 * whole attempt.
 *
 * An exploration call does not need to RUN in the route: nothing reads its
 * result, and the reasoning it fed has already been recorded as a literal in
 * the plan. So it is pruned from the steps.
 *
 * But it does need to COUNT toward the route's identity. It is the only thing
 * saying which outcome this is. Mining on pruned sequences was tried and it
 * collapsed every filesystem goal into one cluster of `read_text_file(path)`
 * with the path free, because once the listing calls are gone, reading the auth
 * module and reading the deploy doc are the same two calls.
 *
 * So: mine on what the caller actually did, prune only the plan, and then merge
 * any two clusters whose pruned plans came out identical. That last step is
 * what lets one goal explored two ways end up as one route, when the two ways
 * really did reach the same place.
 */
export function detect(episodes: Episode[], opts: MineOptions = DEFAULTS): Candidate[] {
  resetParamNames();
  const clusters = mine(episodes, opts);
  const raw: Candidate[] = [];
  for (const cluster of clusters) {
    const analyses = analyze(cluster);
    const { plan, blockedBy } = synthesize(cluster, analyses, opts.config);
    raw.push({
      cluster,
      analyses,
      ...(plan ? { plan } : {}),
      ...(blockedBy ? { blockedBy } : {}),
      score: score(cluster, analyses, plan, opts.config),
    });
  }

  const out = mergeIdenticalPlans(raw, opts);
  out.sort((a, b) => b.score.intermediateTokensSaved - a.score.intermediateTokensSaved);
  return out;
}

/**
 * Two clusters that prune to the same plan are the same route.
 *
 * Mining splits by the exact call sequence, so one goal explored two ways
 * lands in two clusters. Once the exploration calls nobody reads are pruned
 * away, those two plans are byte-identical, and keeping them apart would
 * promote the same route twice and charge its schema cost twice.
 *
 * Members are unioned by trace id, then the candidate is rescored, because
 * support and the token averages both change.
 */
function mergeIdenticalPlans(candidates: Candidate[], opts: MineOptions): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const passthrough: Candidate[] = [];

  for (const c of candidates) {
    if (!c.plan) {
      passthrough.push(c);
      continue;
    }
    const sig = JSON.stringify({ steps: c.plan.steps, returns: c.plan.returns });
    const g = groups.get(sig);
    if (g) g.push(c);
    else groups.set(sig, [c]);
  }

  const merged: Candidate[] = [];
  for (const group of groups.values()) {
    const head = group[0]!;
    if (group.length === 1) {
      merged.push(head);
      continue;
    }
    const seen = new Set<string>();
    const members: Cluster["members"] = [];
    for (const c of group) {
      for (const m of c.cluster.members) {
        if (seen.has(m.episode.traceId)) continue;
        seen.add(m.episode.traceId);
        members.push(m);
      }
    }
    // The shape is now the plan rather than any one mined sequence.
    const cluster: Cluster = {
      shape: { key: head.plan!.name, tools: head.plan!.steps.map((s) => s.call) },
      members,
    };
    const analyses = group.flatMap((c) => c.analyses);
    merged.push({ cluster, analyses, plan: head.plan!, score: score(cluster, analyses, head.plan!) });
  }

  return [...merged, ...passthrough].filter(
    (c) => c.cluster.members.length >= opts.minSupport || !c.plan,
  );
}

/** Mining options for a config, so every entry point builds them the same way. */
export function optionsFor(config?: Config): MineOptions {
  const m = config?.mining ?? {};
  return {
    minSupport: m.minSupport ?? DEFAULTS.minSupport,
    minLength: m.minLength ?? DEFAULTS.minLength,
    maxLength: m.maxLength ?? DEFAULTS.maxLength,
    ...(config ? { config } : {}),
  };
}

export { loadCalls, segment, mine, analyze, synthesize, score, DEFAULTS };
export type { MineOptions };
