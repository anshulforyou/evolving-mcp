/**
 * Stage 6: scoring.
 *
 * The saving is not the call syntax. It is the intermediate results that never
 * reach a model's context. So the headline figure is result tokens removed,
 * counted only for steps whose output the route consumes and discards.
 *
 * Against that sits the cost. A promoted route's schema joins tools/list,
 * which every caller pays for whether they use the route or not. Rather than
 * guess a traffic volume, the ratio between the two is reported: how many
 * tools/list fetches a single use of the route pays for. Above 1 and the route
 * earns its place.
 *
 * The correction that matters most is for discovered params. If a route takes
 * a param whose value only exists inside one of its own early results, the
 * caller has to make that call anyway to learn it, so those tokens arrive
 * regardless and cannot be counted as saved.
 */
import { schemaTokenCost } from "../metrics/tokens.js";
import { isMutating, type Config } from "../config/schema.js";
import type { ArgAnalysis, Cluster, RoutePlan, Score } from "../types.js";

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function score(cluster: Cluster, analyses: ArgAnalysis[], plan?: RoutePlan, config?: Config): Score {
  // Windows are suffixes, so the call the caller was waiting for is always the
  // last one in the window. Computing per member rather than from the cluster
  // shape is what lets a merged cluster hold members whose episodes explored
  // for a different number of calls.

  // A discovered param forces the caller to run the chain up to that step
  // themselves, so the route effectively begins after it.
  const discovered = analyses
    .map((a) => a.discoveredIn)
    .filter((d): d is number => d !== undefined);
  const effectiveStart = discovered.length ? Math.max(...discovered) + 1 : 0;

  const perMember = cluster.members.map((m) => {
    // The caller made every call in the original episode, so that is what a
    // route spares them, not the reduced sequence the miner worked on.
    const orig = m.episode.origCalls;
    const from = orig ? m.episode.origIndex![m.start]! : m.start;
    const window = (orig ?? m.episode.calls).slice(from, orig ? orig.length : m.end);
    const last = window.length - 1;
    let raw = 0;
    let effective = 0;
    for (let i = 0; i < window.length; i++) {
      if (i === last) continue; // the caller still receives this one
      const t = window[i]!.resultTokens;
      raw += t;
      if (i >= effectiveStart) effective += t;
    }
    const kept = plan ? new Set(plan.sourceSteps) : null;
    const latency = window.reduce(
      (a, c, i) => a + (kept === null || kept.has(i) ? c.latencyMs : 0),
      0,
    );
    return { raw, effective, latency, len: window.length };
  });

  const cost = plan ? schemaTokenCost(plan) : 0;
  const effective = Math.round(mean(perMember.map((p) => p.effective)));
  const meanLen = mean(perMember.map((p) => p.len));

  return {
    support: cluster.members.length,
    upstreamCallsPruned: plan ? Math.round(meanLen - plan.steps.length) : 0,
    intermediateTokensSaved: effective,
    rawIntermediateTokensSaved: Math.round(mean(perMember.map((p) => p.raw))),
    roundTripsSaved: Math.max(0, Math.round(meanLen) - 1 - effectiveStart),
    upstreamLatencyMs: Math.round(mean(perMember.map((p) => p.latency))),
    schemaTokenCost: cost,
    mutating: cluster.shape.tools.some((t) => isMutating(config, t)),
    stable: analyses.every((a) => a.role !== "unstable"),
    payoffRatio: cost > 0 ? Math.round((effective / cost) * 100) / 100 : 0,
  };
}
