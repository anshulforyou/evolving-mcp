/**
 * Result normalization.
 *
 * The plan assumed dataflow between calls would be explicit, because MCP
 * 2026-07-28 pushes servers to return handles and take them back as ordinary
 * arguments. Real servers today predate that. The reference sqlite server
 * returns a Python repr inside a text content block:
 *
 *   [{'name': 'artists'}, {'name': 'albums'}]
 *
 * No structuredContent, single quotes, None instead of null. So a value that
 * flows from one call into the next is embedded in a text blob that is not
 * even valid JSON, and JSON-path extraction alone finds nothing.
 *
 * This module turns a result into something addressable by path, and records
 * which normalizer it took. Anything needing a normalizer beyond `json` is a
 * portability caveat that belongs in the report, not something to hide.
 */
import type { Json } from "../types.js";

export type Normalizer = "structured" | "json" | "python-repr" | "none";

export interface NormalizedResult {
  /** Addressable form, or null when nothing could be recovered. */
  value: Json | null;
  normalizer: Normalizer;
  /** Raw payload as the caller received it, for size accounting and for
   *  substring fallback when no normalizer applies. */
  raw: string;
}

/** Pulls the caller-visible payload out of an MCP tool result. */
export function rawText(result: Json): string {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const content = result["content"];
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object" && !Array.isArray(block)) {
          const t = block["text"];
          if (typeof t === "string") parts.push(t);
        }
      }
      if (parts.length) return parts.join("\n");
    }
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

/**
 * Converts a Python repr of a list/dict of scalars into JSON.
 *
 * Deliberately narrow. It handles the shape sqlite-style servers actually
 * emit and refuses anything else rather than guessing, because a normalizer
 * that silently half-parses would corrupt every downstream binding.
 */
function pythonReprToJson(s: string): Json | null {
  const t = s.trim();
  if (!(t.startsWith("[") || t.startsWith("{"))) return null;
  let out = "";
  let i = 0;
  while (i < t.length) {
    const c = t[i]!;
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let lit = "";
      while (j < t.length) {
        if (t[j] === "\\") {
          lit += t[j]! + (t[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (t[j] === quote) break;
        lit += t[j]!;
        j++;
      }
      out += JSON.stringify(lit.replace(/\\'/g, "'"));
      i = j + 1;
      continue;
    }
    if (t.startsWith("None", i) && !/[A-Za-z0-9_]/.test(t[i + 4] ?? "")) { out += "null"; i += 4; continue; }
    if (t.startsWith("True", i) && !/[A-Za-z0-9_]/.test(t[i + 4] ?? "")) { out += "true"; i += 4; continue; }
    if (t.startsWith("False", i) && !/[A-Za-z0-9_]/.test(t[i + 5] ?? "")) { out += "false"; i += 5; continue; }
    out += c;
    i++;
  }
  try {
    return JSON.parse(out) as Json;
  } catch {
    return null;
  }
}

export function normalize(result: Json): NormalizedResult {
  // Preferred path once servers adopt 2026-07-28: structuredContent is
  // already addressable and needs no guessing at all.
  if (result && typeof result === "object" && !Array.isArray(result) && "structuredContent" in result) {
    return { value: result["structuredContent"] as Json, normalizer: "structured", raw: rawText(result) };
  }
  const raw = rawText(result);
  try {
    return { value: JSON.parse(raw) as Json, normalizer: "json", raw };
  } catch {
    /* fall through */
  }
  const py = pythonReprToJson(raw);
  if (py !== null) return { value: py, normalizer: "python-repr", raw };
  return { value: null, normalizer: "none", raw };
}

/* ------------------------------------------------------------------ */
/* Paths                                                              */
/* ------------------------------------------------------------------ */

/** Every leaf in a normalized value, as (path, scalar) pairs. */
export function leaves(value: Json, prefix = "$"): Array<{ path: string; value: string | number | boolean }> {
  const out: Array<{ path: string; value: string | number | boolean }> = [];
  const walk = (v: Json, p: string): void => {
    if (v === null) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
      return;
    }
    out.push({ path: p, value: v });
  };
  walk(value, prefix);
  return out;
}

/** Reads a path produced by `leaves` back out of a value. */
export function readPath(value: Json, path: string): Json | undefined {
  if (!path.startsWith("$")) return undefined;
  let cur: Json | undefined = value;
  const rest = path.slice(1);
  const tokens = rest.match(/\.[^.[\]]+|\[\d+\]/g) ?? [];
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (tok.startsWith("[")) {
      const idx = Number(tok.slice(1, -1));
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
    } else {
      const key = tok.slice(1);
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as { [k: string]: Json })[key];
    }
  }
  return cur;
}

/**
 * Whether a result is really an error, regardless of what the flag says.
 *
 * The phase 1 corpus caught a model inventing a table that does not exist. The
 * reference server answered `Database error: no such table: orders` and set
 * `isError: false`, so the recorder banked it as a successful call. A route
 * mined from a failing call is a route that reliably fails, so the flag alone
 * cannot be trusted and the payload has to be looked at.
 */
export function looksLikeError(result: Json, flagged: boolean): boolean {
  if (flagged) return true;
  const raw = rawText(result).trimStart();
  return /^(database error|error|traceback|exception)\b/i.test(raw);
}
