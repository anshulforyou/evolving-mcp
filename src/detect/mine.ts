/**
 * Stage 3: mining.
 *
 * Find contiguous runs of calls whose shape recurs across episodes.
 *
 * Contiguous only, on purpose. The promotion target in phase 0 is a straight
 * replay, so a pattern with a hole in it is not something a recipe could
 * execute anyway. Gapped patterns are real and deferred rather than dismissed.
 *
 * Windows must also END where the episode ends. A route stands in for an
 * outcome, and the outcome is whatever the caller stopped at. The first run
 * ignored this and the highest scoring candidate was a three-call window sliced
 * out of the middle of longer episodes: list_tables, describe_table,
 * describe_table. It looked like it suppressed nine thousand tokens. What it
 * actually did was return the second table's schema and throw away both the
 * first schema and the query the caller was building toward. A window that
 * stops early does not replace the caller's work, it truncates it.
 *
 * Windows are kept maximal: if a long window and a shorter window inside it
 * have the same support, the long one wins, because collapsing more calls
 * saves more context. A shorter window survives only when it has strictly
 * more support, meaning it recurs somewhere the longer one does not.
 */
import { shapeOf } from "./canon.js";
import type { Cluster, Episode } from "../types.js";

export interface MineOptions {
  minSupport: number;
  minLength: number;
  maxLength: number;
}

export const DEFAULTS: MineOptions = { minSupport: 3, minLength: 2, maxLength: 8 };

export function mine(episodes: Episode[], opts: MineOptions = DEFAULTS): Cluster[] {
  const byKey = new Map<string, Cluster>();

  for (const ep of episodes) {
    const n = ep.calls.length;
    for (let len = Math.min(opts.maxLength, n); len >= opts.minLength; len--) {
      {
        const start = n - len; // suffix windows only, see the note above
        const window = ep.calls.slice(start, start + len);
        const shape = shapeOf(window);
        let cluster = byKey.get(shape.key);
        if (!cluster) {
          cluster = { shape, members: [] };
          byKey.set(shape.key, cluster);
        }
        // One episode contributes at most one instance per shape. Otherwise a
        // repeated sub-shape inside a single episode inflates support and the
        // route looks more popular than its caller base justifies.
        if (!cluster.members.some((m) => m.episode.traceId === ep.traceId)) {
          cluster.members.push({ episode: ep, start, end: start + len });
        }
      }
    }
  }

  const kept = [...byKey.values()].filter((c) => c.members.length >= opts.minSupport);
  kept.sort((a, b) => b.shape.tools.length - a.shape.tools.length || b.members.length - a.members.length);

  // Drop a window that is contained in a longer kept window with at least the
  // same support, in the same set of episodes.
  const survivors: Cluster[] = [];
  for (const c of kept) {
    const covered = survivors.some((s) => contains(s, c));
    if (!covered) survivors.push(c);
  }
  return survivors;
}

function contains(longer: Cluster, shorter: Cluster): boolean {
  if (longer.shape.tools.length <= shorter.shape.tools.length) return false;
  if (longer.members.length < shorter.members.length) return false;
  const idx = longer.shape.key.indexOf(shorter.shape.key);
  if (idx < 0) return false;
  const traces = new Set(longer.members.map((m) => m.episode.traceId));
  return shorter.members.every((m) => traces.has(m.episode.traceId));
}
