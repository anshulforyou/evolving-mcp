/**
 * The normalizer chain.
 *
 * A normalizer answers one question: given two calls that look different, do
 * they mean the same thing. It only matters for tools that take a COMPOSED
 * argument, meaning a string assembled out of parts. A tool taking discrete
 * arguments needs nothing here, because two callers with the same intent
 * produce byte-identical arguments, and that is the case this whole system
 * works best on.
 *
 * Four tiers, in the order they are tried:
 *
 *   0. Nothing. Discrete arguments cluster as they are.
 *   1. DERIVED. For a composed argument nobody has declared a normalizer for,
 *      the call's RESULT SHAPE stands in. Two calls returning the same shape
 *      of data are plausibly the same question with different parameters. This
 *      needs no configuration and no knowledge of the argument's language.
 *   2. DECLARED. The author names a built-in normalizer for one argument.
 *   3. AUTHORED. The author registers their own function for their own
 *      language.
 *
 * Measured on the model-written SQL corpus, scored against goal labels:
 *
 *   raw string                    3 of 8 goals reach support 3
 *   derived result shape          5 of 8, purity 1.00
 *   declared sql normalizer       7 of 8, purity 1.00
 *
 * So tier 1 recovers most of the gap for free and tier 2 is an upgrade rather
 * than an entry fee. Note that combining tier 1 and tier 2 is WORSE than tier
 * 2 alone, 4 of 8, because two constraints ANDed are stricter than either.
 * They are a fallback chain, never a conjunction.
 */
import { canonicalizeAliases } from "./sql.js";
import { footprintKey } from "./footprint.js";
import { normalize } from "./normalize.js";
import type { NormalizerName } from "../config/schema.js";
import type { Json } from "../types.js";

export type Normalizer = (value: string) => string;

const registry = new Map<string, Normalizer>();

/** Tier 3: an author registers a normalizer for their own argument language. */
export function registerNormalizer(name: string, fn: Normalizer): void {
  if (BUILT_IN.has(name)) throw new Error(`cannot override the built-in normalizer ${name}`);
  registry.set(name, fn);
}

/** Test seam. Authored normalizers are process-global otherwise. */
export function clearRegisteredNormalizers(): void {
  registry.clear();
}

const BUILT_IN = new Set<string>(["sql", "path", "opaque", "none"]);

/** A path's structure is its segments; the leaf name is what identifies it. */
const pathNormalizer: Normalizer = (v) => v.replace(/\\/g, "/").replace(/\/+/g, "/");

export function builtIn(name: NormalizerName): Normalizer | undefined {
  switch (name) {
    case "sql":
      // Alias renaming plus the semantic footprint. Falls back to alias-only
      // when the query is beyond what the footprint can read.
      return (v) => footprintKey(v, "loose") ?? canonicalizeAliases(v);
    case "path":
      return pathNormalizer;
    case "opaque":
      // Deliberately collapses everything: the value is an identifier we
      // should not read structure into.
      return () => "<opaque>";
    case "none":
      return (v) => v;
    default:
      return undefined;
  }
}

export function resolveNormalizer(name: string): Normalizer | undefined {
  return builtIn(name as NormalizerName) ?? registry.get(name);
}

/* ------------------------------------------------------------------ */
/* Tier 1: derived from the result                                     */
/* ------------------------------------------------------------------ */

/**
 * The shape of what came back, ignoring every value in it.
 *
 * Argument-side normalization is circular: to learn which variation is
 * irrelevant you must already know which calls mean the same thing. The
 * result is a way out of that, because it is evidence about the call that does
 * not come from the call's own arguments.
 *
 * Degrades honestly. A tool returning a plain text blob yields
 * `scalar:string`, which says nothing and merges nothing it should not.
 */
export function resultShape(result: Json): string {
  const v = normalize(result).value;
  if (v === null) return "opaque";
  const rows = Array.isArray(v) ? v : [v];
  const first = rows[0];
  if (first === null || first === undefined) return "empty";
  if (typeof first !== "object" || Array.isArray(first)) return `scalar:${typeof first}`;
  return `rows:${JSON.stringify(Object.keys(first as object).sort())}`;
}
