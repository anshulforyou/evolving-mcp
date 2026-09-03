/**
 * Pruning exploration calls out of a route.
 *
 * Phase 3 left the bottleneck in the wrong place. Query normalization got good,
 * but coverage stayed near 40% because a route is a whole call sequence and the
 * same goal explored two ways produces two sequences. One caller inspects two
 * tables before querying, another inspects one. Nothing about normalizing the
 * query text can cross that.
 *
 * The way across is to notice what those calls were for. A `describe_table`
 * exists so the model can write the next query. Once the query is in the plan
 * as a literal, that reasoning has already happened and been recorded. If no
 * later step reads anything out of the call's result, the route does not need
 * to make the call at all.
 *
 * So both of these collapse to the same one-step route:
 *
 *   list_tables > describe_table > describe_table > read_query(SQL)
 *   list_tables > describe_table > read_query(SQL)
 *
 * A step is kept when any of these hold:
 *   - something later binds to its result
 *   - it is the step whose result the route returns
 *   - it mutates state, so skipping it would change the world
 *
 * The caller's saving is unchanged: they were never going to see those results
 * either way. What changes is that the route is cheaper to run, and that two
 * differently-explored episodes now have the same shape.
 *
 * The cost is real and worth stating. A pruned route trusts that the schema it
 * was mined against still holds. Nothing re-checks it, so a schema change turns
 * a working route into a failing one, which is what error-driven eviction is
 * for.
 */
import { isBinding, type Binding, type BindingTree, type PlanStep } from "../types.js";

/** Tools that change state and must never be skipped. */
const MUTATING = new Set(["write_query", "create_table", "append_insight", "write_file", "edit_file", "move_file", "create_directory"]);

export const isMutating = (tool: string): boolean => MUTATING.has(tool);

/** Every step index some binding in this tree reads from. */
function readsFrom(tree: BindingTree, into: Set<number>): void {
  if (isBinding(tree)) {
    const b = tree as Binding;
    if (b.kind === "from") into.add(b.step);
    else if (b.kind === "template") {
      for (const p of b.parts) if (typeof p !== "string") readsFrom(p, into);
    }
    return;
  }
  if (Array.isArray(tree)) {
    for (const t of tree) readsFrom(t, into);
    return;
  }
  for (const v of Object.values(tree as { [k: string]: BindingTree })) readsFrom(v, into);
}

export interface Pruned {
  steps: PlanStep[];
  /** Original index of each surviving step. */
  sourceSteps: number[];
  returns: number;
  removed: number;
}

/**
 * Drops steps nothing depends on and rewrites the surviving `from` bindings to
 * the new indices. Runs to a fixed point, because removing a step can make the
 * step it used to read from unreferenced in turn.
 */
export function prune(steps: PlanStep[], returns: number): Pruned {
  let keep = steps.map((_, i) => i);

  for (;;) {
    const referenced = new Set<number>();
    for (const i of keep) readsFrom(steps[i]!.args, referenced);
    const next = keep.filter(
      (i) => i === returns || referenced.has(i) || isMutating(steps[i]!.call),
    );
    if (next.length === keep.length) break;
    keep = next;
  }

  const position = new Map(keep.map((orig, i) => [orig, i]));
  const rewrite = (tree: BindingTree): BindingTree => {
    if (isBinding(tree)) {
      const b = tree as Binding;
      if (b.kind === "from") {
        const at = position.get(b.step);
        // A binding onto a pruned step cannot happen: the step would have been
        // referenced and therefore kept. Guard anyway rather than emit a plan
        // that points at nothing.
        if (at === undefined) throw new Error(`binding onto pruned step ${b.step}`);
        return { kind: "from", step: at, path: b.path };
      }
      if (b.kind === "template") {
        return { kind: "template", parts: b.parts.map((p) => (typeof p === "string" ? p : (rewrite(p) as Binding))) };
      }
      return b;
    }
    if (Array.isArray(tree)) return tree.map(rewrite);
    return Object.fromEntries(
      Object.entries(tree as { [k: string]: BindingTree }).map(([k, v]) => [k, rewrite(v)]),
    );
  };

  return {
    steps: keep.map((i) => ({ call: steps[i]!.call, args: rewrite(steps[i]!.args) as PlanStep["args"] })),
    sourceSteps: keep,
    returns: position.get(returns)!,
    removed: steps.length - keep.length,
  };
}
