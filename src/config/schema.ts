/**
 * The configuration an MCP server author writes once for their own server.
 *
 * Two things live here and they are deliberately separate, because they have
 * different consequences when they are wrong.
 *
 * `mutating` gates PRUNING. A route skips calls nothing reads, and skipping
 * something with a side effect is the worst thing this system can do. So an
 * unclassified tool is assumed to mutate and is never skipped. Being wrong
 * here is dangerous, so the default refuses rather than guesses.
 *
 * `normalizers` gates CLUSTERING. Being wrong here means a route is missed or
 * a route is coarser than it should be. Nothing breaks. So this side is
 * allowed to fall back to derived behaviour with no configuration at all.
 */
import type { Json } from "../types.js";

/** Built-in normalizers. Anything else is registered by the author in code. */
export type NormalizerName = "sql" | "path" | "opaque" | "none";

export type Mutability = "read-only" | "mutating" | "unclassified";

export interface ToolConfig {
  /** Argument paths that must never be folded into a route.
   *
   *  A route is mined from real traffic, and real traffic carries
   *  authorization. A tenant id or an account id that happens to be stable
   *  across a cluster would otherwise become a constant, and every later
   *  caller would run a route carrying somebody else's identity. Marked paths
   *  are always parameters, and a cluster that only holds together because one
   *  of them could be folded is rejected instead of promoted.
   *
   *  Named by the author, never detected. Entropy and key-shaped-string
   *  heuristics work until they do not, and that failure is silent. */
  sensitive?: string[];
  /** Whether calling this changes anything. `unclassified` is treated exactly
   *  as `mutating` everywhere it matters; it exists so a report can tell the
   *  author what still needs a decision. */
  mutability: Mutability;
  /** Per-argument normalizer, keyed by the argument's path (`$.query`). */
  normalizers?: Record<string, NormalizerName>;
  /** Recorded by `init` when the server declared readOnlyHint itself. */
  source?: "annotation" | "author" | "default";
}

export interface Config {
  version: 1;
  runtime?: {
    /** `propose` writes a qualifying route to the store and stops, for the
     *  author to review and commit. `live` serves it immediately.
     *
     *  There is no eviction yet, so a route that starts failing cannot be
     *  withdrawn by the system. In `propose` mode that is fine: the route is in
     *  a file somebody committed and removing it is a revert. In `live` mode it
     *  would fail for every caller with no way out, which is why `live`
     *  requires an explicit opt-in and warns. */
    mode?: "propose" | "live";
    /** The surface only grows without eviction, so it is capped. A stronger
     *  candidate displaces the weakest incumbent. */
    maxRoutes?: number;
    store?: string;
  };
  /** How the server is started, so `trace` and `init` need no arguments. */
  server?: { command: string; args: string[] };
  tools: Record<string, ToolConfig>;
  mining?: {
    minSupport?: number;
    minLength?: number;
    maxLength?: number;
    /** Milliseconds of silence after which the next call starts a new episode,
     *  used only when the client sends no trace context. */
    idleGapMs?: number;
  };
}

export const DEFAULT_MINING = { minSupport: 3, minLength: 2, maxLength: 8, idleGapMs: 30_000 };

export class ConfigError extends Error {}

/** Fails loudly rather than silently disabling a safety rule. */
export function parseConfig(raw: unknown, where: string): Config {
  const fail: (msg: string) => never = (msg) => {
    throw new ConfigError(`${where}: ${msg}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("must be a JSON object");
  const o = raw as Record<string, Json>;
  if (o["version"] !== 1) fail(`unsupported version ${JSON.stringify(o["version"])}, expected 1`);

  const toolsRaw = o["tools"];
  if (typeof toolsRaw !== "object" || toolsRaw === null || Array.isArray(toolsRaw)) fail("`tools` must be an object");

  const tools: Record<string, ToolConfig> = {};
  for (const [name, v] of Object.entries(toolsRaw as Record<string, Json>)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`tools.${name} must be an object`);
    const t = v as Record<string, Json>;
    const m = t["mutability"];
    if (m !== "read-only" && m !== "mutating" && m !== "unclassified") {
      fail(`tools.${name}.mutability must be "read-only", "mutating" or "unclassified", got ${JSON.stringify(m)}`);
    }
    const sensitive: string[] = [];
    const sens = t["sensitive"];
    if (sens !== undefined) {
      if (!Array.isArray(sens)) fail(`tools.${name}.sensitive must be an array of argument paths`);
      for (const v of sens) {
        if (typeof v !== "string" || !v.startsWith("$")) {
          fail(`tools.${name}.sensitive entries must be argument paths like "$.tenant_id", got ${JSON.stringify(v)}`);
        }
        sensitive.push(v);
      }
    }

    const normalizers: Record<string, NormalizerName> = {};
    const n = t["normalizers"];
    if (n !== undefined) {
      if (typeof n !== "object" || n === null || Array.isArray(n)) fail(`tools.${name}.normalizers must be an object`);
      for (const [arg, val] of Object.entries(n as Record<string, Json>)) {
        if (val !== "sql" && val !== "path" && val !== "opaque" && val !== "none") {
          fail(`tools.${name}.normalizers.${arg} is not a known normalizer: ${JSON.stringify(val)}`);
        }
        if (!arg.startsWith("$")) fail(`tools.${name}.normalizers key ${JSON.stringify(arg)} must be an argument path like "$.query"`);
        normalizers[arg] = val;
      }
    }
    const src = t["source"];
    tools[name] = {
      mutability: m,
      ...(sensitive.length ? { sensitive } : {}),
      ...(Object.keys(normalizers).length ? { normalizers } : {}),
      ...(src === "annotation" || src === "author" || src === "default" ? { source: src } : {}),
    };
  }

  const serverRaw = o["server"];
  let server: Config["server"];
  if (serverRaw !== undefined) {
    if (typeof serverRaw !== "object" || serverRaw === null || Array.isArray(serverRaw)) fail("`server` must be an object");
    const s = serverRaw as Record<string, Json>;
    if (typeof s["command"] !== "string") fail("`server.command` must be a string");
    if (!Array.isArray(s["args"]) || s["args"].some((a) => typeof a !== "string")) fail("`server.args` must be an array of strings");
    server = { command: s["command"], args: s["args"] as string[] };
  }

  const runtimeRaw = o["runtime"];
  let runtime: Config["runtime"];
  if (runtimeRaw !== undefined) {
    if (typeof runtimeRaw !== "object" || runtimeRaw === null || Array.isArray(runtimeRaw)) fail("`runtime` must be an object");
    const r = runtimeRaw as Record<string, Json>;
    runtime = {};
    const mode = r["mode"];
    if (mode !== undefined) {
      if (mode !== "propose" && mode !== "live") fail(`runtime.mode must be "propose" or "live", got ${JSON.stringify(mode)}`);
      runtime.mode = mode;
    }
    const max = r["maxRoutes"];
    if (max !== undefined) {
      if (typeof max !== "number" || !Number.isInteger(max) || max <= 0) fail("runtime.maxRoutes must be a positive integer");
      runtime.maxRoutes = max;
    }
    const store = r["store"];
    if (store !== undefined) {
      if (typeof store !== "string" || !store) fail("runtime.store must be a path");
      runtime.store = store;
    }
  }

  const miningRaw = o["mining"];
  let mining: Config["mining"];
  if (miningRaw !== undefined) {
    if (typeof miningRaw !== "object" || miningRaw === null || Array.isArray(miningRaw)) fail("`mining` must be an object");
    const mo = miningRaw as Record<string, Json>;
    mining = {};
    for (const k of ["minSupport", "minLength", "maxLength", "idleGapMs"] as const) {
      const val = mo[k];
      if (val === undefined) continue;
      if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) fail(`mining.${k} must be a positive number`);
      mining[k] = val;
    }
  }

  return {
    version: 1,
    ...(server ? { server } : {}),
    ...(runtime ? { runtime } : {}),
    tools,
    ...(mining ? { mining } : {}),
  };
}

/* ------------------------------------------------------------------ */

/** The single source of truth for whether a tool is safe to skip.
 *  There used to be two hardcoded lists of these, in prune.ts and score.ts,
 *  and they disagreed. */
export function isMutating(config: Config | undefined, tool: string): boolean {
  const t = config?.tools[tool];
  // Unknown and unclassified both mean the same thing at the point it counts:
  // do not skip this call.
  return t?.mutability !== "read-only";
}

export function unclassifiedTools(config: Config): string[] {
  return Object.entries(config.tools)
    .filter(([, t]) => t.mutability === "unclassified")
    .map(([n]) => n)
    .sort();
}

/** Is this argument one the author said must never be folded into a route. */
export function isSensitive(config: Config | undefined, tool: string, argPath: string): boolean {
  return config?.tools[tool]?.sensitive?.includes(argPath) ?? false;
}

export const DEFAULT_RUNTIME = { mode: "propose" as const, maxRoutes: 32, store: "evolving-mcp.routes.json" };

export function normalizerFor(config: Config | undefined, tool: string, argPath: string): NormalizerName | undefined {
  return config?.tools[tool]?.normalizers?.[argPath];
}
