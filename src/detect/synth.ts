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
import type { ArgAnalysis, Binding, Cluster, Json, JsonSchema, PlanStep, RoutePlan } from "../types.js";

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
export function routeName(cluster: Cluster, params: string[]): string {
  const chain = dedupeAdjacent(cluster.shape.tools).join("_then_");
  const suffix = params.length ? `_by_${params.map((p) => p.replace(/_\d+$/, "")).join("_")}` : "";
  const digest = createHash("sha256").update(cluster.shape.key).digest("hex").slice(0, 6);
  const name = `${chain}${suffix}.${digest}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (name.length <= MAX_NAME) return name;
  return `${name.slice(0, MAX_NAME - 7).replace(/[_.]+$/, "")}.${digest}`;
}

const dedupeAdjacent = (xs: string[]): string[] => xs.filter((x, i) => x !== xs[i - 1]);

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
    const holder: Record<string, unknown> = {};
    setPath(holder, a.argPath, a.binding);
    // argPath is always rooted at a single top-level key for MCP tool args.
    for (const [k, v] of Object.entries(holder)) {
      steps[a.step]!.args[k] = v as Binding;
    }
  }

  const properties: Record<string, Json> = {};
  for (const p of paramNames) properties[p] = { type: "string" };
  const inputSchema: JsonSchema = paramNames.size
    ? { type: "object", properties, required: [...paramNames], additionalProperties: false }
    : { type: "object", additionalProperties: false };

  const name = routeName(cluster, [...paramNames]);
  return {
    plan: {
      name,
      description: `Runs ${cluster.shape.tools.length} upstream calls (${dedupeAdjacent(cluster.shape.tools).join(", ")}) as one step and returns the final result.`,
      inputSchema,
      steps,
      returns: steps.length - 1,
    },
  };
}
