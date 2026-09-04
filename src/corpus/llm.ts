/**
 * A thin, cached wrapper around a real model.
 *
 * Phase 0 wrote its own SQL, which meant the same intent always produced a
 * byte-stable skeleton and skeleton clustering could not fail. That was the
 * single biggest limitation in the findings. This exists to remove it: the
 * queries in the phase 1 corpus are written by a model, from the schema it
 * actually saw, against a question phrased differently each time.
 *
 * Every response is cached on disk by prompt hash and the cache is committed.
 * Two reasons. It keeps a rerun from spending anything, and it means someone
 * cloning the repo can reproduce the corpus exactly without a key of their
 * own, which is what the golden test depends on.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** execFile cannot feed stdin, and the prompt has to go there. */
function run(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (c: string) => { out += c; });
    p.stderr.on("data", (c: string) => { err += c; });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(-400)}`)),
    );
    p.stdin.write(input);
    p.stdin.end();
  });
}

const CACHE = process.env["EMCP_LLM_CACHE"] ?? "corpus/llm-cache.json";
const MODEL = process.env["EMCP_MODEL"] ?? "haiku";

type Cache = Record<string, string>;

let cache: Cache = existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, "utf8")) as Cache) : {};
let writes = 0;
let hits = 0;
let spendCalls = 0;
/** Keys this run actually asked for, so entries no recording needs any more
 *  can be dropped instead of sitting in the repo forever. */
const used = new Set<string>();

const key = (system: string, prompt: string): string =>
  createHash("sha256").update(`${MODEL}\n${system}\n${prompt}`).digest("hex").slice(0, 32);

export function cacheStats(): { hits: number; calls: number; entries: number } {
  return { hits, calls: spendCalls, entries: Object.keys(cache).length };
}

export function flushCache(opts: { prune?: boolean } = {}): void {
  const kept = opts.prune
    ? Object.fromEntries(Object.entries(cache).filter(([k]) => used.has(k)))
    : cache;
  const dropped = Object.keys(cache).length - Object.keys(kept).length;
  if (!writes && !dropped) return;
  mkdirSync("corpus", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(kept, Object.keys(kept).sort(), 2) + "\n");
  if (dropped) console.log(`  pruned ${dropped} unused cache entries`);
}

const SQL_SYSTEM =
  "You write SQLite SQL. Output ONLY the query on a single line. No markdown, no code fences, no explanation, no trailing semicolon.";

const PICK_SYSTEM =
  "You pick exactly one file path from a listing. Output ONLY the path, exactly as it appears. No markdown, no explanation.";

export const askForSql = (prompt: string): Promise<string> => ask(SQL_SYSTEM, prompt);
export const askToPickPath = (prompt: string): Promise<string> => ask(PICK_SYSTEM, prompt);

async function ask(SYSTEM: string, prompt: string): Promise<string> {
  const k = key(SYSTEM, prompt);
  used.add(k);
  const cached = cache[k];
  if (cached !== undefined) {
    hits++;
    return cached;
  }
  if (process.env["EMCP_OFFLINE"] === "1") {
    throw new Error(`cache miss in offline mode for ${k}. Run with a model available to populate it.`);
  }
  spendCalls++;
  // The prompt goes on stdin, not as a positional argument. --disallowed-tools
  // is variadic, so a trailing prompt argument gets parsed as one more tool
  // name and the CLI then reports having received no input at all.
  const stdout = await run(
    "claude",
    [
      "-p", "--model", MODEL,
      "--disallowed-tools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task",
      "--system-prompt", SYSTEM,
      "--max-turns", "1",
      "--output-format", "json",
    ],
    prompt,
  );
  const parsed = JSON.parse(stdout) as { result?: string };
  const text = (parsed.result ?? "").trim().replace(/^```\w*\n?|\n?```$/g, "").replace(/;\s*$/, "").trim();
  if (!text) throw new Error("empty completion");
  cache[k] = text;
  writes++;
  return text;
}
