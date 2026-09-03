/**
 * Selection.
 *
 * The miner emits overlapping candidates. The same three calls in the same
 * episode get covered by a two-step window, a three-step window and a longer
 * window that contains both, and each of those scores well on its own.
 *
 * Promoting all of them would be a mistake in a specific way: the schema cost
 * multiplies, because every route joins tools/list, while the saving does not,
 * because a call's result can only be kept out of the context once. Summing
 * per-candidate savings produced a call coverage of 139% on the first run,
 * which is how the double count showed up.
 *
 * So routes are chosen greedily against calls already covered. A route is
 * credited only for the results no already-selected route was going to
 * suppress, and it is only taken if it still pays for its own schema on that
 * incremental basis. This is a greedy approximation of a set-cover problem and
 * makes no claim to be optimal.
 */
import { schemaTokenCost } from "../metrics/tokens.js";
import type { Candidate } from "../types.js";

/** Steps before this one are ones the caller has to run themselves anyway, to
 *  learn a discovered param. Their results reach the context regardless, so
 *  they cannot be counted here either. score() applies the same correction;
 *  the first version of this file did not, and credited a route with the
 *  tokens of the very call its caller was forced to make. */
const effectiveStart = (c: Candidate): number => {
  const discovered = c.analyses.map((a) => a.discoveredIn).filter((d): d is number => d !== undefined);
  return discovered.length ? Math.max(...discovered) + 1 : 0;
};

export interface Selection {
  candidate: Candidate;
  /** Result tokens this route suppresses that nothing already selected did. */
  incrementalTokens: number;
  /** Distinct calls it is the first to absorb. */
  incrementalCalls: number;
}

const cellId = (traceId: string, seq: number): string => `${traceId}:${seq}`;

export function select(candidates: Candidate[]): Selection[] {
  const withPlan = candidates.filter((c) => c.plan && c.score.intermediateTokensSaved > 0);
  const ranked = [...withPlan].sort(
    (a, b) =>
      b.score.intermediateTokensSaved * b.score.support -
      a.score.intermediateTokensSaved * a.score.support,
  );

  const covered = new Set<string>();
  const chosen: Selection[] = [];

  for (const c of ranked) {
    let tokens = 0;
    let cells = 0;
    const claim: string[] = [];

    const from = effectiveStart(c);
    for (const m of c.cluster.members) {
      const orig = m.episode.origCalls;
      const at = orig ? m.episode.origIndex![m.start]! : m.start;
      const window = (orig ?? m.episode.calls).slice(at, orig ? orig.length : m.end);
      for (let i = 0; i < window.length; i++) {
        const call = window[i]!;
        const id = cellId(call.traceId, call.seq);
        if (covered.has(id)) continue;
        claim.push(id);
        cells++;
        // The final result still goes back to the caller, so it is absorbed
        // but not suppressed.
        if (i !== window.length - 1 && i >= from) tokens += call.resultTokens;
      }
    }

    const cost = schemaTokenCost(c.plan!);
    if (tokens <= cost) continue; // does not pay for its own schema any more
    for (const id of claim) covered.add(id);
    chosen.push({ candidate: c, incrementalTokens: tokens, incrementalCalls: cells });
  }

  return chosen;
}
