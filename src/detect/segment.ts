/** Stage 1: group calls into episodes by trace id. */
import { readFileSync } from "node:fs";
import type { Episode, LabelledCall } from "../types.js";

export function loadCalls(path: string): LabelledCall[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LabelledCall);
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
