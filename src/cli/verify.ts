/**
 * Held-out verification.
 *
 * Mine routes on 70% of episodes, then take the 30% the miner never saw and
 * ask, for each one: is there a route whose shape matches what this caller
 * did, and if the route is run with this caller's own inputs, does it come
 * back with the same answer the caller actually got?
 *
 * This is the falsifier from the plan. Token savings computed off a detector
 * that quietly returns the wrong answer are worth nothing, so this runs
 * against the live server and compares real payloads.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { detect, loadCalls, optionsFor, segment } from "../detect/index.js";
import { loadConfig } from "../config/load.js";
import { select } from "../detect/select.js";
import { shapeOf } from "../detect/canon.js";
import { normalize } from "../detect/normalize.js";
import { alignSteps, recoverParams, runRoute } from "../detect/interpret.js";
import { StdioMcpClient } from "../mcp/client.js";
import { fromPortable } from "../corpus/portable.js";
import type { Episode, Json, RoutePlan } from "../types.js";

const DB = process.env["EMCP_DB"] ?? "corpus/store.db";
const CORPUS = process.env["EMCP_CORPUS"] ?? "corpus/traces.jsonl";
const TREE = process.env["EMCP_TREE"] ?? "corpus/tree";

/** Which upstream server this corpus was recorded against. */
const SERVER: [string, string[]] = process.env["EMCP_SERVER"] === "fs"
  ? ["npx", ["-y", "@modelcontextprotocol/server-filesystem", resolve(TREE)]]
  : ["uvx", ["--quiet", "--from", "mcp-server-sqlite", "--with", "mcp==1.9.4", "mcp-server-sqlite", "--db-path", DB]];

/** Deterministic 70/30 split, stable across runs and machines. */
function split(episodes: Episode[]): { train: Episode[]; test: Episode[] } {
  const train: Episode[] = [];
  const test: Episode[] = [];
  for (const ep of episodes) {
    const h = parseInt(createHash("sha256").update(ep.traceId).digest("hex").slice(0, 8), 16);
    (h % 10 < 7 ? train : test).push(ep);
  }
  return { train, test };
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  const config = loadConfig();
const episodes = segment(loadCalls(CORPUS));
  const { train, test } = split(episodes);
  const routes = select(detect(train, optionsFor(config))).map((s) => s.candidate);

  // Index by the shape of each member's own window, not by the cluster's shape.
  // A merged candidate covers several original sequences and its cluster shape
  // is the plan, not any one of them, so keying off the cluster would make a
  // merged route unmatchable. That regression cost a held-out run.
  const byShape = new Map<string, RoutePlan>();
  for (const c of routes) {
    if (!c.plan) continue;
    for (const m of c.cluster.members) {
      byShape.set(shapeOf(m.episode.calls.slice(m.start, m.end), config).key, c.plan);
    }
  }

  console.log(`train ${train.length} episodes, held out ${test.length}`);
  console.log(`routes mined on train: ${routes.length}\n`);

  const client = new StdioMcpClient(SERVER[0], SERVER[1]);
  await client.initialize();

  // The corpus stores machine-independent paths, so expand them at the moment
  // a call actually goes out. The route stays portable, the server sees a real
  // path.
  const sink = {
    callTool: (name: string, args: Json): Promise<Json> => client.callTool(name, fromPortable(args)),
  };

  let matched = 0, correct = 0, wrong = 0, unrecoverable = 0, threw = 0;
  let tokensSaved = 0;
  const failures: string[] = [];

  for (const ep of test) {
    // A route replaces a suffix of what the caller did, so try the longest
    // suffix first.
    let hit: { plan: RoutePlan; start: number } | undefined;
    for (let start = 0; start < ep.calls.length; start++) {
      const plan = byShape.get(shapeOf(ep.calls.slice(start), config).key);
      if (plan) { hit = { plan, start }; break; }
    }
    if (!hit) continue;
    matched++;

    const window = ep.calls.slice(hit.start);
    // The plan no longer has a step for every call the caller made, so line the
    // surviving steps back up with the calls they came from.
    const aligned = alignSteps(hit.plan, window);
    if (!aligned) { unrecoverable++; failures.push(`${ep.goalId}: plan does not line up with the calls made`); continue; }
    const params = recoverParams(hit.plan, aligned.map((i) => window[i]!.args));
    if (!params) { unrecoverable++; failures.push(`${ep.goalId}: params not recoverable`); continue; }

    try {
      const { result } = await runRoute(hit.plan, fromPortable(params), sink);
      const got = normalize(result).raw;
      const want = normalize(window[window.length - 1]!.result).raw;
      if (eq(got, want)) {
        correct++;
        for (let i = 0; i < window.length - 1; i++) tokensSaved += window[i]!.resultTokens;
      } else {
        wrong++;
        failures.push(`${ep.goalId}: result differs\n      want ${want.slice(0, 110)}\n      got  ${got.slice(0, 110)}`);
      }
    } catch (e) {
      threw++;
      failures.push(`${ep.goalId}: ${(e as Error).message}`);
    }
  }
  client.close();

  const heldOutTokens = test.reduce((a, ep) => a + ep.calls.reduce((x, c) => x + c.resultTokens, 0), 0);
  console.log(`## Held-out replay
  episodes matched by a route   ${matched} of ${test.length}
  replayed to the same answer   ${correct}
  replayed to a DIFFERENT answer ${wrong}
  params not recoverable        ${unrecoverable}
  threw                         ${threw}
  correctness on matched        ${matched ? ((correct / matched) * 100).toFixed(0) : "n/a"}%

  held-out result tokens        ${heldOutTokens.toLocaleString()}
  tokens the routes suppress    ${tokensSaved.toLocaleString()}  (${((tokensSaved / heldOutTokens) * 100).toFixed(1)}%)`);

  if (failures.length) {
    console.log(`\n## Failures (${failures.length})`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f}`);
  }
  if (wrong > 0) process.exitCode = 1;
}

await main();
