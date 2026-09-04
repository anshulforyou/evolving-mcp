/**
 * Deciding what earns a place on the tool surface.
 *
 * The rule is economic rather than a tuned threshold. A route keeps result
 * tokens out of a model's context every time it is used, and costs schema
 * tokens on every `tools/list` any caller ever makes, whether they use it or
 * not. It earns its place when the first exceeds the second.
 *
 * With no eviction, the surface only grows, so it is capped and a stronger
 * candidate displaces the weakest incumbent. A route that has never been
 * served can be displaced without breaking anybody.
 */
import { schemaTokenCost } from "../metrics/tokens.js";
import { activeRoutes, type RouteStore, type StoredRoute } from "./store.js";
import { DEFAULT_RUNTIME, type Config } from "../config/schema.js";
import { TREE_SENTINEL } from "../corpus/portable.js";
import { isBinding, type BindingTree } from "../types.js";
import type { Selection } from "../detect/select.js";

export interface PromotionResult {
  store: RouteStore;
  added: StoredRoute[];
  updated: StoredRoute[];
  displaced: StoredRoute[];
  rejected: Array<{ name: string; why: string }>;
}

const strength = (r: StoredRoute): number => r.evidence.payoffRatio;

/**
 * Does any constant in this plan still hold a portability placeholder.
 *
 * The corpora committed to this repo store machine-independent paths so they
 * reproduce anywhere. A route mined from one carries that placeholder in its
 * constants, and serving it sends the server a path that does not exist. It is
 * the sort of thing that looks like it works right up until the first call.
 *
 * The runtime is not taught to expand it, because that would push a corpus
 * convention into the product. Such a route simply is not executable, so it is
 * refused here with a reason that says why.
 */
function hasPlaceholder(tree: BindingTree): boolean {
  if (isBinding(tree)) {
    if (tree.kind === "const") return JSON.stringify(tree.value).includes(TREE_SENTINEL);
    if (tree.kind === "template") {
      return tree.parts.some((p) => (typeof p === "string" ? p.includes(TREE_SENTINEL) : hasPlaceholder(p)));
    }
    return false;
  }
  if (Array.isArray(tree)) return tree.some(hasPlaceholder);
  return Object.values(tree as { [k: string]: BindingTree }).some(hasPlaceholder);
}

export function promote(
  store: RouteStore,
  selections: Selection[],
  config: Config | undefined,
  now = new Date(),
): PromotionResult {
  const mode = config?.runtime?.mode ?? DEFAULT_RUNTIME.mode;
  const cap = config?.runtime?.maxRoutes ?? DEFAULT_RUNTIME.maxRoutes;

  const routes = [...store.routes];
  const added: StoredRoute[] = [];
  const updated: StoredRoute[] = [];
  const displaced: StoredRoute[] = [];
  const rejected: Array<{ name: string; why: string }> = [];

  for (const s of selections) {
    const plan = s.candidate.plan;
    if (!plan) continue;
    const score = s.candidate.score;
    const cost = schemaTokenCost(plan);
    const payoff = cost > 0 ? s.incrementalTokens / cost : 0;

    if (score.mutating) {
      // Either a tool the author called mutating, or one they have not
      // classified. Both mean the same thing here: not without a decision.
      rejected.push({ name: plan.name, why: "contains a mutating or unclassified call" });
      continue;
    }
    if (plan.steps.some((st) => hasPlaceholder(st.args))) {
      rejected.push({
        name: plan.name,
        why: `holds the ${TREE_SENTINEL} portability placeholder, so it was mined from a normalized corpus and is not executable`,
      });
      continue;
    }
    if (payoff <= 1) {
      rejected.push({ name: plan.name, why: `saves less than its own schema costs (payoff ${payoff.toFixed(2)})` });
      continue;
    }

    const evidence = {
      support: score.support,
      tokensSaved: s.incrementalTokens,
      schemaTokenCost: cost,
      payoffRatio: Math.round(payoff * 100) / 100,
      upstreamCallsPruned: score.upstreamCallsPruned,
      firstSeen: now.toISOString().slice(0, 10),
    };

    const existing = routes.find((r) => r.plan.name === plan.name);
    if (existing) {
      // Keep whatever status it already had. A route somebody activated does
      // not silently revert because it was seen again.
      existing.plan = plan;
      existing.evidence = { ...evidence, firstSeen: existing.evidence?.firstSeen ?? evidence.firstSeen };
      updated.push(existing);
      continue;
    }

    const entry: StoredRoute = { plan, evidence, status: mode === "live" ? "active" : "proposed" };

    if (routes.length < cap) {
      routes.push(entry);
      added.push(entry);
      continue;
    }

    const weakest = routes.reduce((a, b) => (strength(a) <= strength(b) ? a : b));
    if (strength(entry) <= strength(weakest)) {
      rejected.push({ name: plan.name, why: `surface is full at ${cap} and this is weaker than ${weakest.plan.name}` });
      continue;
    }
    routes.splice(routes.indexOf(weakest), 1);
    displaced.push(weakest);
    routes.push(entry);
    added.push(entry);
  }

  return { store: { version: store.version, routes }, added, updated, displaced, rejected };
}

/** How much schema every caller pays on every tools/list, right now. */
export const servedSchemaCost = (store: RouteStore): number =>
  activeRoutes(store).reduce((a, p) => a + schemaTokenCost(p), 0);
