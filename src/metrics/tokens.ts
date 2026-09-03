/**
 * Token accounting.
 *
 * Measured with cl100k_base. It is not Claude's tokenizer, so treat absolute
 * counts as within a few percent rather than exact. Every number this project
 * reports is a ratio or a difference between two quantities counted the same
 * way, and those are stable across BPE tokenizers. Bytes are also recorded
 * everywhere so any claim can be re-derived without trusting this choice.
 */
import { encode } from "gpt-tokenizer";
import type { Json, RoutePlan } from "../types.js";

export function countTokens(text: string): number {
  return encode(text).length;
}

/** Size of a payload as it would enter a model's context. */
export function measure(value: Json): { bytes: number; tokens: number } {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return { bytes: Buffer.byteLength(s, "utf8"), tokens: countTokens(s) };
}

/**
 * What a route costs every caller on every request.
 *
 * A promoted route is not free. Its schema joins tools/list, which under MCP
 * 2026-07-28 is cacheable but still paid by every caller that refreshes it,
 * whether or not they ever call the route. This is the negative term in the
 * net equation and the reason eviction is load-bearing rather than hygiene.
 */
export function schemaTokenCost(plan: RoutePlan): number {
  return countTokens(
    JSON.stringify({
      name: plan.name,
      description: plan.description,
      inputSchema: plan.inputSchema,
    }),
  );
}
