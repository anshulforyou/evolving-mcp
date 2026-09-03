/**
 * Stage 2: canonicalization.
 *
 * Reduce a run of calls to a shape with every value stripped out, so two runs
 * that differ only in what they were asked about collapse to the same key.
 * Argument *names* are kept because they are structure.
 *
 * Argument values are stripped, with one exception the corpus forced. Tools
 * that take a composed string carry their real structure inside that string:
 * `read_query` is always `{query: string}`, so on tool names alone every
 * question ever asked of the database collapses into one cluster, unrelated
 * SQL and all. The first run of the detector did exactly that and six of eight
 * clusters were unpromotable as a result.
 *
 * So a string argument contributes a skeleton: its tokens with quoted literals
 * and numbers masked, keywords and identifiers kept. `WHERE customer_id = 12`
 * and `WHERE customer_id = 77` share a skeleton. A different query does not.
 * The literals stay out of the key, which is what leaves the next stage free
 * to decide whether each one is a constant, a parameter or derived.
 */
import { tokenize } from "./dataflow.js";
import { canonicalizeAliases } from "./sql.js";
import { footprintKey } from "./footprint.js";
import type { Json, RecordedCall, Shape } from "../types.js";

/** Sorted argument paths of one call, so key order cannot affect the shape. */
export function argPaths(args: Json, prefix = "$"): string[] {
  const out: string[] = [];
  const walk = (v: Json, p: string): void => {
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) {
        // Array length is structure. Two calls passing different-length
        // arrays are not the same shape.
        v.forEach((x, i) => walk(x, `${p}[${i}]`));
        return;
      }
      const keys = Object.keys(v).sort();
      if (keys.length === 0) out.push(p);
      for (const k of keys) walk((v as { [k: string]: Json })[k]!, `${p}.${k}`);
      return;
    }
    out.push(p);
  };
  walk(args, prefix);
  return out;
}

/** Masks leaf literals out of a composed string, keeping its structure.
 *  Language-aware normalization runs first, so that two strings which differ
 *  only in what they named things reach the same skeleton. */
export function skeleton(s: string, opts: { aliases?: boolean } = {}): string {
  const src = opts.aliases === false ? s : canonicalizeAliases(s);
  return tokenize(src)
    .map((t) => {
      if (/^'/.test(t)) return "'?'";
      if (/^\d/.test(t)) return "?";
      if (/^\s+$/.test(t)) return " ";
      return t;
    })
    .join("")
    .trim();
}

/** Structural signature of one call's arguments, values masked. */
export function argSignature(args: Json, prefix = "$"): string[] {
  const out: string[] = [];
  const walk = (v: Json, p: string): void => {
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${p}[${i}]`));
        return;
      }
      const keys = Object.keys(v).sort();
      if (keys.length === 0) out.push(p);
      for (const k of keys) walk((v as { [k: string]: Json })[k]!, `${p}.${k}`);
      return;
    }
    // Only strings long enough to have internal structure contribute a
    // signature. A short scalar is a value, not a shape.
    //
    // A language-aware footprint is preferred where one applies. It keeps what
    // determines the answer (tables, grouping, filters, aggregates) and drops
    // what a model varies freely between askings. The lexical skeleton is the
    // fallback for composed strings nothing understands yet.
    if (typeof v === "string" && v.length > 24) {
      const fp = FOOTPRINTS ? footprintKey(v, "loose") : null;
      out.push(`${p}=${fp ?? skeleton(v)}`);
    } else out.push(p);
  };
  walk(args, prefix);
  return out;
}

/** Language-aware normalization can be turned off to measure what it is worth.
 *  Set EMCP_FOOTPRINT=0 to fall back to the lexical skeleton everywhere. */
const FOOTPRINTS = process.env["EMCP_FOOTPRINT"] !== "0";

export function shapeOf(calls: RecordedCall[]): Shape {
  const parts = calls.map((c) => `${c.tool}(${argSignature(c.args).join(",")})`);
  return { key: parts.join(" > "), tools: calls.map((c) => c.tool) };
}
