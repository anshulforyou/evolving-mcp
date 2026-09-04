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
import { resolveNormalizer, resultShape } from "./normalizers.js";
import { normalizerFor, type Config } from "../config/schema.js";
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

/** Was this string assembled out of parts, or is it a single opaque value. */
export function isComposed(s: string): boolean {
  return /[/\\\s(),=]/.test(s);
}

/** Masks leaf literals out of a composed string, keeping its structure.
 *  Language-aware normalization runs first, so that two strings which differ
 *  only in what they named things reach the same skeleton. */
export function skeleton(s: string, opts: { aliases?: boolean } = {}): string {
  // SQL alias renaming is NOT applied by default any more. It used to fire on
  // anything starting with SELECT, which is fine inside this repo and wrong as
  // a public contract: a tool whose argument happens to begin with that word
  // would get rewritten by rules that do not apply to it. It is now reachable
  // only by declaring the `sql` normalizer on a specific argument.
  const src = opts.aliases === true ? canonicalizeAliases(s) : s;
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
export function argSignature(
  args: Json,
  prefix = "$",
  ctx?: { tool: string; config?: Config; onUndeclaredComposed?: () => void },
): string[] {
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
    // A string contributes a signature when it is COMPOSED, meaning it was
    // assembled out of parts: a path, a query, anything with separators in it.
    // An atomic scalar like a table name is a value, and deciding whether it
    // is constant, parameter or derived is the next stage's job.
    //
    // This used to be a length test, `v.length > 24`, and that turned out to
    // be accidentally load-bearing. Absolute paths cleared the bar and were
    // quietly carrying each goal's identity in the shape key. Shortening them
    // to a portable form dropped them below it and coverage fell from 97% to
    // 57%, with nothing else changed. Length was never the property that
    // mattered.
    //
    // A language-aware footprint is preferred where one applies. It keeps what
    // determines the answer (tables, grouping, filters, aggregates) and drops
    // what a model varies freely between askings. The lexical skeleton is the
    // fallback for composed strings nothing understands yet.
    if (typeof v === "string" && isComposed(v)) {
      // Tier 2 and 3: the author said how to read this argument.
      const declared = ctx ? normalizerFor(ctx.config, ctx.tool, p) : undefined;
      const fn = declared ? resolveNormalizer(declared) : undefined;
      if (fn) {
        out.push(`${p}=${fn(v)}`);
      } else {
        // Nobody declared one. Tier 1 takes over for this argument: the
        // result shape REPLACES the lexical skeleton rather than joining it.
        // Appending both was measured and it is strictly worse, 12.1% against
        // 38.2% of suppressible tokens, because two constraints ANDed split
        // clusters that either alone would have kept together. The comment in
        // normalizers.ts said fallback chain; the first implementation was a
        // conjunction anyway.
        if (ctx?.onUndeclaredComposed?.()) {
          out.push(`${p}=<derived>`);
        } else {
          out.push(`${p}=${skeleton(v)}`);
        }
      }
    } else out.push(p);
  };
  walk(args, prefix);
  return out;
}

/**
 * Tier 1 is OFF by default because it was measured and it loses.
 *
 * On the model-written SQL corpus: no normalizer at all promotes 3 routes and
 * saves 12.1% of suppressible tokens, the derived result shape promotes 2 and
 * saves 8.5%, and a declared `sql` normalizer promotes 6 and saves 40.4%.
 *
 * It looked good in isolation, where clustering queries by result shape beat
 * clustering them by raw string, 5 goals of 8 against 3, and never once merged
 * two different goals. That did not survive integration. A shape key spans a
 * whole episode, so substituting a coarse result shape for a specific argument
 * merges episodes across goals, and the clusters that come out have arguments
 * too varied to template.
 *
 * Kept, off, behind EMCP_DERIVED=1, because the negative result is worth being
 * able to reproduce and a different corpus may not share it.
 */
const DERIVED = process.env["EMCP_DERIVED"] === "1";

export function shapeOf(calls: RecordedCall[], config?: Config): Shape {
  const parts = calls.map((c) => {
    let undeclared = false;
    const args = argSignature(c.args, "$", {
      tool: c.tool,
      ...(config ? { config } : {}),
      onUndeclaredComposed: () => {
        if (!DERIVED) return false;
        undeclared = true;
        return true;
      },
    });
    // Tier 1. A composed argument nobody explained is the case where the
    // arguments alone cannot say whether two calls mean the same thing, so
    // what came back stands in. Only then: adding it everywhere would make
    // every shape stricter for no gain, and stricter is not better here.
    const derived = undeclared && DERIVED ? `->${resultShape(c.result)}` : "";
    return `${c.tool}(${args.join(",")})${derived}`;
  });
  return { key: parts.join(" > "), tools: calls.map((c) => c.tool) };
}
