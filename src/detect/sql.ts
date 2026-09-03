/**
 * SQL-aware normalization.
 *
 * Phase 1 showed that a model asked the same question six ways writes between
 * two and six structurally different queries, and that lexical matching cannot
 * see through any of it. Of the five kinds of variation observed, one is
 * mechanical to remove: alias naming. `SUM(total) as revenue` and
 * `SUM(total) as total_spent` are the same query.
 *
 * Stripping the alias does nothing, because the alias is referenced again in
 * ORDER BY, so removing only the definition leaves the reference behind and
 * the two strings still differ. What works is renaming every alias to a
 * canonical position and rewriting every use of it.
 *
 * Measured on the phase 1 corpus: 37 distinct skeletons drop to 29, and goals
 * reaching support 3 go from 3 of 8 to 5 of 8.
 *
 * This is deliberately SQL-specific and only fires on something that looks
 * like SQL. That is the general shape of the problem rather than a wart: a
 * server whose tools take composed strings needs a normalizer that understands
 * the language in the string, so a real framework needs these registered per
 * tool rather than one universal rule.
 */

const LOOKS_LIKE_SQL = /^\s*(select|with|insert|update|delete)\b/i;

/** Reserved words that can follow a table name without being an alias. */
const NOT_AN_ALIAS = new Set([
  "on", "where", "group", "order", "join", "left", "right", "inner", "outer",
  "cross", "limit", "having", "union", "as", "using", "natural", "set", "values",
]);

export function isSql(s: string): boolean {
  return LOOKS_LIKE_SQL.test(s);
}

/** Every identifier the query introduces as a name for something. */
export function aliasesIn(sql: string): string[] {
  const found: string[] = [];
  const add = (a: string | undefined): void => {
    if (a && !found.includes(a)) found.push(a);
  };
  for (const m of sql.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) add(m[1]);
  for (const m of sql.matchAll(/\b(?:from|join)\s+[A-Za-z_][A-Za-z0-9_]*\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    if (!NOT_AN_ALIAS.has((m[1] ?? "").toLowerCase())) add(m[1]);
  }
  return found;
}

/**
 * Renames aliases to canonical positions, so two queries that differ only in
 * what they called things collapse to one string.
 *
 * Known limit: an alias that happens to share a name with a real column is
 * rewritten everywhere, including where the column was meant. Doing this
 * properly needs a parser rather than word boundaries, and that is the next
 * piece of work, along with projection and construct equivalence.
 */
export function canonicalizeAliases(sql: string): string {
  if (!isSql(sql)) return sql;
  let out = sql;
  aliasesIn(sql).forEach((alias, i) => {
    out = out.replace(new RegExp(`\\b${alias}\\b`, "g"), `a${i + 1}`);
  });
  return out;
}
