/**
 * Semantic footprint of a SQL query.
 *
 * Lexical matching fails because a model asked the same question twice varies
 * everything that does not change the answer: alias names, join direction,
 * projection order, qualification, whitespace. The footprint throws all of
 * that away and keeps what actually determines what comes back.
 *
 *   tables touched, columns projected, columns grouped by, columns filtered
 *   on, aggregate functions applied
 *
 * Aliases are resolved against the tables they name, so `c.last_name` and
 * `customers.last_name` are the same thing. Literals are dropped, since a
 * varying literal is exactly what becomes a route parameter.
 *
 * Two strengths are reported separately because the tradeoff is the whole
 * question. STRICT keeps the projection, so `SELECT *` and `SELECT name` stay
 * apart, since they hand the caller different answers. LOOSE drops it, which
 * merges more and risks merging things that are not the same question.
 *
 * Regex rather than a parser, on purpose: this is meant to be cheap enough to
 * run on every call. Its failure modes are documented at each step and the
 * measurement in `npm run footprint` is what says whether they matter.
 */
import { isSql } from "./sql.js";

const KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "having", "limit", "offset",
  "join", "left", "right", "inner", "outer", "cross", "on", "using", "as", "and",
  "or", "not", "in", "exists", "is", "null", "like", "between", "distinct", "all",
  "union", "case", "when", "then", "else", "end", "asc", "desc", "natural", "with",
]);

const AGGREGATES = new Set(["count", "sum", "avg", "min", "max", "total", "group_concat"]);

/** Masks string and numeric literals. A varying literal becomes a parameter,
 *  so it must not take part in identity. */
function dropLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "?").replace(/\b\d+(?:\.\d+)?\b/g, "?");
}

/** Splits on commas that are not inside parentheses. */
function topLevelSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** alias -> table, plus the set of tables the query reads. */
function tableMap(sql: string): { tables: Set<string>; alias: Map<string, string> } {
  const tables = new Set<string>();
  const alias = new Map<string, string>();
  for (const m of sql.matchAll(
    /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi,
  )) {
    const table = m[1]!.toLowerCase();
    tables.add(table);
    const a = m[2]?.toLowerCase();
    if (a && !KEYWORDS.has(a)) alias.set(a, table);
    alias.set(table, table);
  }
  return { tables, alias };
}

/** Column references in a fragment, resolved through aliases. */
function columnsIn(fragment: string, ctx: { tables: Set<string>; alias: Map<string, string> }): string[] {
  const out: string[] = [];
  const only = ctx.tables.size === 1 ? [...ctx.tables][0]! : null;
  for (const m of fragment.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_*][A-Za-z0-9_]*)|\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    if (m[1] && m[2]) {
      const table = ctx.alias.get(m[1].toLowerCase()) ?? m[1].toLowerCase();
      out.push(`${table}.${m[2].toLowerCase()}`);
      continue;
    }
    const word = m[3]?.toLowerCase();
    if (!word || KEYWORDS.has(word) || AGGREGATES.has(word)) continue;
    if (ctx.tables.has(word)) continue; // a table name, not a column
    if (ctx.alias.has(word)) continue; // an alias, already handled
    out.push(only ? `${only}.${word}` : word);
  }
  return out;
}

const section = (sql: string, start: RegExp, stop: RegExp): string => {
  const m = start.exec(sql);
  if (!m) return "";
  const rest = sql.slice(m.index + m[0].length);
  const end = stop.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
};

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export interface Footprint {
  tables: string[];
  projected: string[];
  grouped: string[];
  filtered: string[];
  aggregates: string[];
  limited: boolean;
}

export function footprintOf(sqlRaw: string): Footprint | null {
  if (!isSql(sqlRaw)) return null;
  const sql = dropLiterals(sqlRaw).replace(/\s+/g, " ").trim();
  const ctx = tableMap(sql);
  if (!ctx.tables.size) return null;

  const selectList = section(sql, /\bselect\b(?:\s+distinct)?/i, /\bfrom\b/i);
  const whereClause =
    section(sql, /\bwhere\b/i, /\b(group\s+by|order\s+by|limit|having)\b/i) +
    " " +
    section(sql, /\bhaving\b/i, /\b(order\s+by|limit)\b/i);
  const groupClause = section(sql, /\bgroup\s+by\b/i, /\b(order\s+by|limit|having)\b/i);
  const joinConds = [...sql.matchAll(/\bon\b([^)]*?)(?=\b(?:join|left|right|inner|where|group|order|limit)\b|$)/gi)]
    .map((m) => m[1] ?? "")
    .join(" ");

  const aggregates: string[] = [];
  const projected: string[] = [];
  for (const item of topLevelSplit(selectList)) {
    const body = item.replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i, "").trim();
    for (const a of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const fn = a[1]!.toLowerCase();
      if (AGGREGATES.has(fn)) aggregates.push(fn);
    }
    if (/^\*$|\.\*$/.test(body)) projected.push("*");
    else projected.push(...columnsIn(body, ctx));
  }

  return {
    tables: sorted(ctx.tables),
    projected: sorted(projected),
    grouped: sorted(columnsIn(groupClause, ctx)),
    // Join conditions are structure, not intent: the same question joined two
    // ways would otherwise look like two questions.
    filtered: sorted(columnsIn(whereClause, ctx)),
    aggregates: sorted(aggregates),
    limited: /\blimit\b/i.test(sql),
    ...(joinConds ? {} : {}),
  };
}

/** Keeps the projection. `SELECT *` and `SELECT name` hand back different
 *  answers, so under STRICT they are different routes. */
export function strictKey(f: Footprint): string {
  return JSON.stringify([f.tables, f.projected, f.grouped, f.filtered, f.aggregates, f.limited]);
}

/** Drops the projection. Merges more, and can merge questions that are not the
 *  same question. This is the setting a promotion-time check would guard. */
export function looseKey(f: Footprint): string {
  return JSON.stringify([f.tables, f.grouped, f.filtered, f.aggregates]);
}

export function footprintKey(sql: string, mode: "strict" | "loose"): string | null {
  const f = footprintOf(sql);
  if (!f) return null;
  return mode === "strict" ? strictKey(f) : looseKey(f);
}
