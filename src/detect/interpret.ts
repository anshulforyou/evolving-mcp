/**
 * The route interpreter.
 *
 * This is the whole argument for routes being data rather than generated code.
 * It is one small function with no eval, no codegen and no model in it. A
 * route cannot do anything the upstream server could not already do, and it
 * does the same thing every time it runs, which is what makes a snapshot test
 * of promoted routes meaningful at all.
 */
import { normalize, readPath } from "./normalize.js";
import { tokenize } from "./dataflow.js";
import { isBinding, type Binding, type BindingTree, type Json, type RoutePlan } from "../types.js";

export interface CallSink {
  callTool(name: string, args: Json): Promise<Json>;
}

function resolve(b: Binding, params: Record<string, Json>, results: Json[]): Json {
  switch (b.kind) {
    case "const":
      return b.value;
    case "param": {
      if (!(b.name in params)) throw new Error(`missing param ${b.name}`);
      return params[b.name]!;
    }
    case "from": {
      const norm = normalize(results[b.step] ?? null);
      if (norm.value === null) throw new Error(`step ${b.step} result is not addressable`);
      const v = readPath(norm.value, b.path);
      if (v === undefined) throw new Error(`no value at ${b.path} in step ${b.step}`);
      return v;
    }
    case "template": {
      let out = "";
      for (const part of b.parts) {
        if (typeof part === "string") out += part;
        else out += String(resolve(part, params, results));
      }
      return out;
    }
  }
}

/** Walks a step's binding tree, producing the concrete args object. */
function build(tree: BindingTree, params: Record<string, Json>, results: Json[]): Json {
  if (isBinding(tree)) return resolve(tree, params, results);
  if (Array.isArray(tree)) return tree.map((t) => build(t, params, results));
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(tree as { [k: string]: BindingTree })) {
    out[k] = build(v, params, results);
  }
  return out;
}

export async function runRoute(
  plan: RoutePlan,
  params: Record<string, Json>,
  sink: CallSink,
): Promise<{ result: Json; stepResults: Json[] }> {
  const stepResults: Json[] = [];
  for (const step of plan.steps) {
    const args = build(step.args, params, stepResults) as Json;
    stepResults.push(await sink.callTool(step.call, args));
  }
  return { result: stepResults[plan.returns]!, stepResults };
}

/* ------------------------------------------------------------------ */
/* Recovering params from a real call, for held-out verification      */
/* ------------------------------------------------------------------ */

/**
 * Reads a template's param values back out of a concrete string.
 *
 * Literal chunks act as anchors and whatever sits between them is the value.
 * Used only by verification, to ask "given what this caller actually sent,
 * would the route have produced the same answer".
 */
export function unifyTemplate(
  parts: Array<string | Binding>,
  actual: string,
): Record<string, Json> | null {
  const out: Record<string, Json> = {};
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (typeof part === "string") {
      if (actual.startsWith(part, pos)) {
        pos += part.length;
        continue;
      }
      return null;
    }
    // A hole. It runs until the next literal anchor, or to the end.
    const next = parts[i + 1];
    let end: number;
    if (typeof next === "string") {
      end = actual.indexOf(next, pos);
      if (end < 0) return null;
    } else {
      // Two holes in a row: fall back to one token's worth.
      const tok = tokenize(actual.slice(pos))[0] ?? "";
      end = pos + tok.length;
    }
    if (part.kind === "param") out[part.name] = actual.slice(pos, end);
    pos = end;
  }
  return pos === actual.length ? out : null;
}

/** Recovers every param of a plan from one real episode's arguments. */
export function recoverParams(
  plan: RoutePlan,
  actualArgs: Json[],
): Record<string, Json> | null {
  const params: Record<string, Json> = {};

  const walk = (tree: BindingTree, actual: Json | undefined): boolean => {
    if (actual === undefined) return false;
    if (isBinding(tree)) {
      if (tree.kind === "param") {
        params[tree.name] = actual;
        return true;
      }
      if (tree.kind === "template") {
        if (typeof actual !== "string") return false;
        const got = unifyTemplate(tree.parts, actual);
        if (!got) return false;
        Object.assign(params, got);
        return true;
      }
      return true; // const and from need nothing from the caller
    }
    if (Array.isArray(tree)) {
      if (!Array.isArray(actual)) return false;
      return tree.every((t, i) => walk(t, actual[i]));
    }
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
    return Object.entries(tree as { [k: string]: BindingTree }).every(([k, v]) =>
      walk(v, (actual as { [k: string]: Json })[k]),
    );
  };

  for (let s = 0; s < plan.steps.length; s++) {
    if (!walk(plan.steps[s]!.args, actualArgs[s] ?? null)) return null;
  }
  return params;
}
