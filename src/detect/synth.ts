/**
 * Stage 5: synthesis. Turn an analyzed cluster into a callable route.
 *
 * The route is data, not code. An ordered list of upstream calls with
 * bindings, run by one fixed interpreter. It cannot do anything the upstream
 * server could not already do, the server author can read exactly what it will
 * do, and it behaves identically every time, which is what lets the corpus
 * test assert a snapshot at all.
 *
 * A cluster with any unstable argument yields no plan. What blocked it is
 * recorded instead, because that list is the evidence for whether a small set
 * of control primitives would be worth adding.
 */
import { createHash } from "node:crypto";
import { prune } from "./prune.js";
import { isBinding, type ArgAnalysis, type Binding, type BindingTree, type Cluster, type Json, type JsonSchema, type PlanStep, type RoutePlan } from "../types.js";

const MAX_NAME = 128;

/**
 * Deterministic name from the chain itself.
 *
 * A real deployment would have a model write something nicer. What matters
 * here is that it is stable across runs, that its length is realistic since
 * the name lands in the schema cost, and that it is unique within the server.
 * MCP requires uniqueness, and the first run of this produced four routes
 * called the same thing because the chain alone does not identify a cluster.
 * The shape digest is what makes it unique.
 */
export function routeName(tools: string[], params: string[], digestSource: string): string {
  const chain = dedupeAdjacent(tools).join("_then_");
  const suffix = params.length ? `_by_${params.map((p) => p.replace(/_\d+$/, "")).join("_")}` : "";
  const digest = createHash("sha256").update(digestSource).digest("hex").slice(0, 6);
  const name = `${chain}${suffix}.${digest}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (name.length <= MAX_NAME) return name;
  return `${name.slice(0, MAX_NAME - 7).replace(/[_.]+$/, "")}.${digest}`;
}

const dedupeAdjacent = (xs: string[]): string[] => xs.filter((x, i) => x !== xs[i - 1]);

/** Every argument is a bare parameter, so the route carries no knowledge. */
function isPassthrough(step: PlanStep): boolean {
  const bare = (t: BindingTree): boolean => {
    if (isBinding(t)) return (t as Binding).kind === "param";
    if (Array.isArray(t)) return t.every(bare);
    return Object.values(t as { [k: string]: BindingTree }).every(bare);
  };
  const args = Object.values(step.args);
  return args.length > 0 && args.every(bare);
}

function collectTreeParams(t: BindingTree, into: Set<string>): void {
  if (Array.isArray(t)) { for (const x of t) collectTreeParams(x, into); return; }
  if (typeof t === "object" && t !== null && "kind" in t) { collectParams(t as Binding, into); return; }
  for (const v of Object.values(t as { [k: string]: BindingTree })) collectTreeParams(v, into);
}

function collectParams(b: Binding, into: Set<string>): void {
  if (b.kind === "param") into.add(b.name);
  else if (b.kind === "template") {
    for (const p of b.parts) if (typeof p !== "string") collectParams(p, into);
  }
}

/** Writes a value into a nested object at a `$.a.b[0]` style path. */
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const tokens = path.slice(1).match(/\.[^.[\]]+|\[\d+\]/g) ?? [];
  let cur: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const last = i === tokens.length - 1;
    const key = tok.startsWith("[") ? Number(tok.slice(1, -1)) : tok.slice(1);
    if (last) {
      (cur as Record<string | number, unknown>)[key] = value;
      return;
    }
    const nextTok = tokens[i + 1]!;
    const existing = (cur as Record<string | number, unknown>)[key];
    if (existing === undefined) {
      (cur as Record<string | number, unknown>)[key] = nextTok.startsWith("[") ? [] : {};
    }
    cur = (cur as Record<string | number, unknown>)[key] as Record<string, unknown>;
  }
}

export interface Synthesized {
  plan?: RoutePlan;
  blockedBy?: string;
}

export function synthesize(cluster: Cluster, analyses: ArgAnalysis[]): Synthesized {
  const unstable = analyses.filter((a) => a.role === "unstable");
  if (unstable.length) {
    return {
      blockedBy: unstable
        .map((a) => `step ${a.step} ${a.argPath}: ${a.note ?? "unstable"}`)
        .join(" | "),
    };
  }

  const paramNames = new Set<string>();
  for (const a of analyses) if (a.binding) collectParams(a.binding, paramNames);

  const steps: PlanStep[] = cluster.shape.tools.map((tool) => ({ call: tool, args: {} }));
  for (const a of analyses) {
    if (!a.binding) continue;
    // Bindings are written into the same nested shape the upstream tool
    // expects, so a step's args read like the call it will make.
    setPath(steps[a.step]!.args as Record<string, unknown>, a.argPath, a.binding);
  }

  const properties: Record<string, Json> = {};
  for (const p of paramNames) properties[p] = { type: "string" };
  const inputSchema: JsonSchema = paramNames.size
    ? { type: "object", properties, required: [...paramNames], additionalProperties: false }
    : { type: "object", additionalProperties: false };

  // Exploration calls whose results nothing reads are dropped here, which is
  // what lets two episodes that explored differently reach the same route.
  const pruned = prune(steps, steps.length - 1);

  // Pruning can leave a route that is the upstream tool wearing a hat. If one
  // step survives and every argument of it is a free parameter, the caller
  // supplies exactly what they would have supplied to the tool itself, and the
  // route adds a name and nothing else.
  //
  // It is worse than useless on this data. `read_query(query)` scores well,
  // because the exploration calls it drops really were suppressed, but nobody
  // can write that query without first reading the schema, so the caller makes
  // those calls anyway and the saving never happens.
  if (pruned.steps.length === 1 && isPassthrough(pruned.steps[0]!)) {
    return {
      blockedBy:
        `pruned to a single ${pruned.steps[0]!.call} whose arguments are all free parameters, ` +
        `which is the upstream tool under another name`,
    };
  }
  const signature = JSON.stringify({ steps: pruned.steps, returns: pruned.returns });
  const name = routeName(pruned.steps.map((x) => x.call), [...paramNames], signature);

  return {
    plan: {
      name,
      description:
        `Replaces ${cluster.shape.tools.length} upstream calls with ${pruned.steps.length} ` +
        `(${dedupeAdjacent(pruned.steps.map((x) => x.call)).join(", ")}) and returns the final result.`,
      inputSchema,
      steps: pruned.steps,
      returns: pruned.returns,
      sourceSteps: pruned.sourceSteps,
    },
  };
}
