/**
 * The recorded trace format, version 1.
 *
 * This stops being an internal detail the moment somebody points this at their
 * own server, because they will hand-generate traces from logs they already
 * have rather than run our proxy. So it is a contract: versioned, validated,
 * and forgiving about the fields a hand-written file has no way to supply.
 *
 * Strict about anything that changes a result, lenient about anything that can
 * be recomputed. A missing `tool` is an error. A missing `resultTokens` is not,
 * so nobody needs a tokenizer to write one of these by hand.
 */
import { measure } from "../metrics/tokens.js";
import { rawText } from "../detect/normalize.js";
import type { Json, RecordedCall } from "../types.js";

export const TRACE_VERSION = 1;

/** How the episode this call belongs to was decided. */
export type Boundary = "traceparent" | "idle-gap" | "process";

export interface TraceRow extends RecordedCall {
  version: number;
  boundary: Boundary;
  /** Present only on this repo's own corpora, which record what the caller was
   *  really trying to do so a cluster can be scored against intent. Never an
   *  input to detection, and absent from real traffic. */
  goalId?: string;
  variant?: string;
}

export class TraceFormatError extends Error {}

const isObj = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseRow(raw: unknown, where: string): TraceRow {
  const fail: (msg: string) => never = (msg) => {
    throw new TraceFormatError(`${where}: ${msg}`);
  };
  if (!isObj(raw)) fail("each line must be a JSON object");
  const o = raw;

  const version = o["version"] ?? TRACE_VERSION;
  if (version !== TRACE_VERSION) fail(`unsupported trace version ${JSON.stringify(version)}, expected ${TRACE_VERSION}`);

  const traceId = o["traceId"];
  const tool = o["tool"];
  if (typeof traceId !== "string" || !traceId) fail("`traceId` is required and must be a non-empty string");
  if (typeof tool !== "string" || !tool) fail("`tool` is required and must be a non-empty string");
  const seq = o["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    fail("`seq` is required and must be a non-negative integer");
  }
  if (o["args"] === undefined) fail("`args` is required (use {} for a tool that takes none)");
  if (o["result"] === undefined) fail("`result` is required");

  const boundary = o["boundary"] ?? "process";
  if (boundary !== "traceparent" && boundary !== "idle-gap" && boundary !== "process") {
    fail(`\`boundary\` must be "traceparent", "idle-gap" or "process", got ${JSON.stringify(boundary)}`);
  }

  const result = o["result"] as Json;
  const rb = o["resultBytes"];
  const rt = o["resultTokens"];
  const measured =
    typeof rt === "number" && typeof rb === "number" ? { tokens: rt, bytes: rb } : measure(rawText(result));

  return {
    version: TRACE_VERSION,
    traceId,
    seq,
    tsMs: typeof o["tsMs"] === "number" ? o["tsMs"] : 0,
    caller: typeof o["caller"] === "string" ? o["caller"] : "unknown",
    tool,
    args: o["args"] as Json,
    result,
    isError: o["isError"] === true,
    latencyMs: typeof o["latencyMs"] === "number" ? o["latencyMs"] : 0,
    resultBytes: measured.bytes,
    resultTokens: measured.tokens,
    boundary,
    ...(typeof o["goalId"] === "string" ? { goalId: o["goalId"] } : {}),
    ...(typeof o["variant"] === "string" ? { variant: o["variant"] } : {}),
  };
}

export function parseTrace(text: string, where: string): TraceRow[] {
  const out: TraceRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new TraceFormatError(`${where}:${i + 1}: not valid JSON (${(e as Error).message})`);
    }
    out.push(parseRow(parsed, `${where}:${i + 1}`));
  }
  if (!out.length) throw new TraceFormatError(`${where}: no rows`);
  return out;
}
