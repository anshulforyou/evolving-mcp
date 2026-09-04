/**
 * Stage 4: dataflow extraction. The core of the detector.
 *
 * For every argument of every step in a cluster, decide across all members
 * whether the value is baked in, supplied by the caller, or read out of an
 * earlier step's result.
 *
 * Two things the real world forced in here that the plan did not anticipate.
 *
 * First, results are unstructured. The reference sqlite server returns a
 * Python repr in a text block with no structuredContent, so derivation has to
 * run over a normalized reconstruction rather than a real JSON document.
 *
 * Second, dataflow is embedded rather than exact. A table name does not arrive
 * as its own argument, it arrives spliced into a SQL string. So a string
 * argument is diffed token by token across members and rebuilt as a template
 * with holes, and each hole is classified on its own.
 *
 * The distinction that decides whether a route is worth anything is between a
 * param the user's question supplies and a param that only exists in an
 * earlier result. The second kind is not free. If a route exposes it, the
 * caller has to make the discovery call to learn it, and the tokens the route
 * was supposed to save arrive anyway.
 */
import { isSensitive, type Config } from "../config/schema.js";
import { leaves, normalize, type NormalizedResult } from "./normalize.js";
import { argPaths } from "./canon.js";
import { readPath } from "./normalize.js";
import type { ArgAnalysis, Binding, Cluster, Json } from "../types.js";

/** Splits a string into tokens that survive reassembly exactly. */
export function tokenize(s: string): string[] {
  return s.match(/'(?:[^']|'')*'|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|\s+|./g) ?? [];
}

interface MemberView {
  /** Args of each step in the window. */
  args: Json[];
  /** Normalized result of each step in the window. */
  results: NormalizedResult[];
}

function viewOf(cluster: Cluster): MemberView[] {
  return cluster.members.map((m) => {
    const window = m.episode.calls.slice(m.start, m.end);
    return {
      args: window.map((c) => c.args),
      results: window.map((c) => normalize(c.result)),
    };
  });
}

/**
 * Looks for `value` among the leaves of every step before `step`.
 * Returns the candidate locations, nearest step first.
 */
function findInEarlier(
  views: MemberView[],
  memberIdx: number,
  step: number,
  value: string,
): Array<{ step: number; path: string }> {
  const hits: Array<{ step: number; path: string }> = [];
  const view = views[memberIdx]!;
  for (let s = step - 1; s >= 0; s--) {
    const norm = view.results[s];
    if (!norm || norm.value === null) continue;
    for (const leaf of leaves(norm.value)) {
      if (String(leaf.value) === value) hits.push({ step: s, path: leaf.path });
    }
  }
  return hits;
}

/** A (step, path) pair that resolves to the right value in every member. */
function consistentSource(
  views: MemberView[],
  step: number,
  valueOf: (memberIdx: number) => string,
): { step: number; path: string } | null {
  const first = findInEarlier(views, 0, step, valueOf(0));
  for (const cand of first) {
    const ok = views.every((_, i) => {
      const v = views[i]!.results[cand.step];
      if (!v || v.value === null) return false;
      const got = readPath(v.value, cand.path);
      return got !== undefined && got !== null && String(got) === valueOf(i);
    });
    if (ok) return cand;
  }
  return null;
}

/** Which earlier step contained the value at all, ignoring path stability. */
function foundAnywhere(
  views: MemberView[],
  step: number,
  valueOf: (memberIdx: number) => string,
): number | undefined {
  const perMember = views.map((_, i) => findInEarlier(views, i, step, valueOf(i)));
  if (perMember.some((h) => h.length === 0)) return undefined;
  const steps = perMember.map((h) => h[0]!.step);
  const first = steps[0]!;
  return steps.every((s) => s === first) ? first : undefined;
}

let paramSeq = 0;
const freshParam = (hint: string): string => {
  const base = hint.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "arg";
  return `${base}_${++paramSeq}`;
};

/** SQL words that describe the query rather than the data in it. */
const NOISE = new Set([
  "select","from","where","and","or","not","in","join","left","right","inner","outer","on","group",
  "by","order","having","limit","offset","as","asc","desc","count","sum","avg","min","max","round",
  "distinct","null","is","like","between","case","when","then","else","end","inner","union","all",
]);

/**
 * Names a hole after the nearest identifier before it.
 *
 * `WHERE customer_id = 12` names the hole `customer_id`, not `v17`. This is
 * cosmetic for correctness and load-bearing for the numbers, because the
 * parameter name lands in the tool schema and the schema is the cost side of
 * the payoff ratio.
 */
const nameFromContext = (toks: string[], at: number, fallback: string): string => {
  for (let i = at - 1; i >= 0 && at - i < 12; i--) {
    const t = toks[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && !NOISE.has(t.toLowerCase())) {
      return t.includes(".") ? t.split(".").pop()! : t;
    }
  }
  return fallback;
};

export function resetParamNames(): void {
  paramSeq = 0;
}

/** Classifies one argument path of one step across the whole cluster. */
function analyzeArg(views: MemberView[], step: number, path: string, sensitive: boolean): ArgAnalysis {
  const raw = views.map((v) => readPath(v.args[step] ?? null, path));
  if (raw.some((r) => r === undefined)) {
    return { step, argPath: path, role: "unstable", note: "argument absent in some members" };
  }
  const values = raw as Json[];
  const strings = values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));

  // A value the author marked sensitive is always supplied by the caller, even
  // when every member of the cluster used the same one. Folding it would mean
  // later callers running a route that carries the identity of whoever it was
  // mined from.
  if (sensitive) {
    return {
      step,
      argPath: path,
      role: "param",
      binding: { kind: "param", name: freshParam(path.replace(/^\$\.?/, "")) },
      note: "marked sensitive, so it is never folded into the route",
    };
  }

  // 1. Identical everywhere. Bake it in.
  if (strings.every((s) => s === strings[0])) {
    return { step, argPath: path, role: "const", binding: { kind: "const", value: values[0]! } };
  }

  // 2. Whole value read out of an earlier result at a stable path.
  const src = consistentSource(views, step, (i) => strings[i]!);
  if (src) {
    return { step, argPath: path, role: "derived", binding: { kind: "from", step: src.step, path: src.path } };
  }

  // 3. A string that differs only in places. Rebuild it as a template.
  if (values.every((v) => typeof v === "string")) {
    const tmpl = templateFor(views, step, strings);
    if (tmpl) return { step, argPath: path, ...tmpl };
  }

  // 4. Varies freely. The caller supplies it, but check whether the caller
  //    could have known it without making the discovery call first.
  const discoveredIn = foundAnywhere(views, step, (i) => strings[i]!);
  return {
    step,
    argPath: path,
    role: "param",
    binding: { kind: "param", name: freshParam(path.replace(/^\$\.?/, "")) },
    ...(discoveredIn !== undefined ? { discoveredIn } : {}),
    ...(discoveredIn !== undefined
      ? { note: `value only obtainable from step ${discoveredIn}; exposing it forfeits that step's saving` }
      : {}),
  };
}

/** Token-aligned template extraction across the members' strings. */
function templateFor(
  views: MemberView[],
  step: number,
  strings: string[],
): Pick<ArgAnalysis, "role" | "binding" | "note" | "discoveredIn"> | null {
  const toks = strings.map(tokenize);
  const len = toks[0]!.length;
  if (!toks.every((t) => t.length === len)) {
    return {
      role: "unstable",
      note: "string arguments differ in structure, not just in values, so no single template covers them",
    };
  }

  const parts: Array<string | Binding> = [];
  let discoveredIn: number | undefined;
  const notes: string[] = [];
  let holes = 0;

  for (let i = 0; i < len; i++) {
    const col = toks.map((t) => t[i]!);
    if (col.every((c) => c === col[0])) {
      parts.push(col[0]!);
      continue;
    }
    holes++;
    // A hole. Prefer reading it out of an earlier result, unquoted or quoted.
    const bare = col.map((c) => c.replace(/^'|'$/g, ""));
    const src =
      consistentSource(views, step, (m) => col[m]!) ??
      consistentSource(views, step, (m) => bare[m]!);
    if (src) {
      parts.push({ kind: "from", step: src.step, path: src.path });
      continue;
    }
    const where = foundAnywhere(views, step, (m) => bare[m]!);
    if (where !== undefined) {
      discoveredIn = where;
      notes.push(`hole ${holes} is only obtainable from step ${where}, so a select-by-predicate primitive would internalise it`);
    }
    parts.push({ kind: "param", name: freshParam(nameFromContext(toks[0]!, i, `v${i}`)) });
  }

  if (holes === 0) return null;
  const merged = mergeLiterals(parts);

  // A "template" that is a single hole with no literal around it is not a
  // template, it is the argument itself. Fall through and let it be classified
  // as a plain param, which keeps the plan honest and readable.
  if (merged.length === 1 && typeof merged[0] !== "string") return null;

  // The role turns on whether anything is actually read out of an earlier
  // result. A string stitched together purely from caller-supplied values is a
  // parameterized argument, not a derivation.
  const readsEarlier = merged.some((p) => typeof p !== "string" && p.kind === "from");
  return {
    role: readsEarlier ? "derived" : "param",
    binding: { kind: "template", parts: merged },
    ...(discoveredIn !== undefined ? { discoveredIn } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}

function mergeLiterals(parts: Array<string | Binding>): Array<string | Binding> {
  const out: Array<string | Binding> = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (typeof p === "string" && typeof last === "string") out[out.length - 1] = last + p;
    else out.push(p);
  }
  return out;
}

export function analyze(cluster: Cluster, config?: Config): ArgAnalysis[] {
  const views = viewOf(cluster);
  const out: ArgAnalysis[] = [];
  const steps = cluster.shape.tools.length;
  const sensitiveValues: string[] = [];

  for (let step = 0; step < steps; step++) {
    const tool = cluster.shape.tools[step]!;
    for (const path of argPaths(views[0]!.args[step] ?? null)) {
      if (path === "$") continue; // no arguments on this call
      const sensitive = isSensitive(config, tool, path);
      if (sensitive) {
        for (const v of views) {
          const raw = readPath(v.args[step] ?? null, path);
          if (raw !== undefined && raw !== null && typeof raw !== "object") sensitiveValues.push(String(raw));
        }
      }
      out.push(analyzeArg(views, step, path, sensitive));
    }
  }

  // A sensitive value can also reach a route by hiding inside somebody else's
  // composed string, where marking the field it came from would not have saved
  // it. `SELECT ... WHERE tenant = 'acme'` folds "acme" into a SQL literal.
  // A cluster that only holds together because of that is refused, rather than
  // promoted with the value in it.
  if (sensitiveValues.length) {
    for (const a of out) {
      if (!a.binding || a.binding.kind !== "template") continue;
      for (const part of a.binding.parts) {
        if (typeof part !== "string") continue;
        const hit = sensitiveValues.find((v) => v.length > 1 && part.includes(v));
        if (hit) {
          a.role = "unstable";
          a.note = `a value marked sensitive was folded into this string literal, so the route is refused`;
          delete a.binding;
          break;
        }
      }
    }
  }

  return out;
}
