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
import type { ArgAnalysis, Cluster, RoutePlan, Score } from "../types.js";

/** Tools that change state. MCP has annotations for this but the reference
 *  server predates them, so the set is named explicitly rather than guessed
 *  from the tool name. */
const MUTATING = new Set(["write_query", "create_table", "append_insight"]);

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function score(cluster: Cluster, analyses: ArgAnalysis[], plan?: RoutePlan): Score {
  const steps = cluster.shape.tools.length;
  const returnedStep = steps - 1;

  // A discovered param forces the caller to run the chain up to that step
  // themselves, so the route effectively begins after it.
  const discovered = analyses
    .map((a) => a.discoveredIn)
    .filter((d): d is number => d !== undefined);
  const effectiveStart = discovered.length ? Math.max(...discovered) + 1 : 0;

  const perMember = cluster.members.map((m) => {
    const window = m.episode.calls.slice(m.start, m.end);
    let raw = 0;
    let effective = 0;
    for (let i = 0; i < window.length; i++) {
      if (i === returnedStep) continue; // the caller still receives this one
      const t = window[i]!.resultTokens;
      raw += t;
      if (i >= effectiveStart) effective += t;
    }
    return { raw, effective, latency: window.reduce((a, c) => a + c.latencyMs, 0) };
  });

  const cost = plan ? schemaTokenCost(plan) : 0;
  const effective = Math.round(mean(perMember.map((p) => p.effective)));

  return {
    support: cluster.members.length,
    intermediateTokensSaved: effective,
    rawIntermediateTokensSaved: Math.round(mean(perMember.map((p) => p.raw))),
    roundTripsSaved: Math.max(0, steps - 1 - effectiveStart),
    upstreamLatencyMs: Math.round(mean(perMember.map((p) => p.latency))),
    schemaTokenCost: cost,
    mutating: cluster.shape.tools.some((t) => MUTATING.has(t)),
    stable: analyses.every((a) => a.role !== "unstable"),
    payoffRatio: cost > 0 ? Math.round((effective / cost) * 100) / 100 : 0,
  };
}
