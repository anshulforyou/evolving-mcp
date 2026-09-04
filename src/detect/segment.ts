/** Stage 1: group calls into episodes by trace id. */
import { readFileSync } from "node:fs";
import { parseTrace } from "../trace/format.js";
import type { Episode, LabelledCall } from "../types.js";

/**
 * Every trace is read through the format validator.
 *
 * This used to be a raw JSON.parse per line, which meant a hand-written trace
 * was never checked and a proxy-written one was never completed. The proxy
 * deliberately does not count tokens, because doing it in the forwarding path
 * blocks the event loop, so it omits `resultTokens` and expects them to be
 * recomputed on read. With a bare parse they arrived as undefined and every
 * number downstream came out NaN.
 */
export function loadCalls(path: string): LabelledCall[] {
  return parseTrace(readFileSync(path, "utf8"), path) as LabelledCall[];
}

export function segment(calls: LabelledCall[]): Episode[] {
  const byTrace = new Map<string, LabelledCall[]>();
  for (const c of calls) {
    const arr = byTrace.get(c.traceId);
    if (arr) arr.push(c);
    else byTrace.set(c.traceId, [c]);
  }
  const episodes: Episode[] = [];
  for (const [traceId, cs] of byTrace) {
    cs.sort((a, b) => a.seq - b.seq);
    const head = cs[0]!;
    episodes.push({ traceId, caller: head.caller, goalId: head.goalId, variant: head.variant, calls: cs });
  }
  return episodes;
}
