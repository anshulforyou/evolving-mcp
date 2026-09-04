/**
 * The route store: a JSON file, on purpose.
 *
 * It is the thing an author reviews, diffs, commits and reverts. That is what
 * makes `propose` mode work at all, what keeps `live` mode auditable, and what
 * lets a tool surface be rolled back with git rather than a migration. An
 * embedded database would handle concurrent writes better and would be
 * unreadable by the person accountable for what it contains.
 *
 * There is no eviction in this version. A promoted route stays until somebody
 * removes it. So the store is CAPPED instead: a stronger candidate displaces
 * the weakest incumbent, which bounds the schema cost every caller pays on
 * every request without needing a withdrawal mechanism. Displacing a route
 * that was never served breaks nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Json, RoutePlan } from "../types.js";

export const STORE_VERSION = 1;

export interface StoredRoute {
  plan: RoutePlan;
  /** Why this earned its place, kept so a reviewer does not have to trust us. */
  evidence: {
    support: number;
    tokensSaved: number;
    schemaTokenCost: number;
    payoffRatio: number;
    upstreamCallsPruned: number;
    firstSeen: string;
  };
  /** `proposed` routes are not served. `active` ones are. */
  status: "proposed" | "active";
}

export interface RouteStore {
  version: number;
  routes: StoredRoute[];
}

export class StoreError extends Error {}

export function emptyStore(): RouteStore {
  return { version: STORE_VERSION, routes: [] };
}

export function loadStore(path: string): RouteStore {
  if (!existsSync(path)) return emptyStore();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new StoreError(`${path}: not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new StoreError(`${path}: must be an object`);
  const o = raw as Record<string, Json>;
  if (o["version"] !== STORE_VERSION) {
    throw new StoreError(`${path}: unsupported store version ${JSON.stringify(o["version"])}, expected ${STORE_VERSION}`);
  }
  if (!Array.isArray(o["routes"])) throw new StoreError(`${path}: \`routes\` must be an array`);

  const routes: StoredRoute[] = [];
  for (const [i, r] of (o["routes"] as Json[]).entries()) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw new StoreError(`${path}: routes[${i}] must be an object`);
    const e = r as Record<string, Json>;
    const status = e["status"];
    if (status !== "proposed" && status !== "active") {
      throw new StoreError(`${path}: routes[${i}].status must be "proposed" or "active"`);
    }
    const plan = e["plan"];
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) throw new StoreError(`${path}: routes[${i}].plan is missing`);
    const p = plan as unknown as RoutePlan;
    if (typeof p.name !== "string" || !Array.isArray(p.steps)) throw new StoreError(`${path}: routes[${i}].plan is malformed`);
    routes.push({ plan: p, evidence: e["evidence"] as unknown as StoredRoute["evidence"], status });
  }

  const names = routes.map((r) => r.plan.name);
  if (new Set(names).size !== names.length) throw new StoreError(`${path}: duplicate route names, which MCP does not allow`);
  return { version: STORE_VERSION, routes };
}

export function saveStore(path: string, store: RouteStore): void {
  mkdirSync(dirname(path) || ".", { recursive: true });
  // Sorted by name so a diff shows what actually changed rather than a
  // reordering. This file is meant to be reviewed.
  const routes = [...store.routes].sort((a, b) => a.plan.name.localeCompare(b.plan.name));
  writeFileSync(path, JSON.stringify({ version: STORE_VERSION, routes }, null, 2) + "\n");
}

/** Routes that are actually served. */
export const activeRoutes = (store: RouteStore): RoutePlan[] =>
  store.routes.filter((r) => r.status === "active").map((r) => r.plan);
