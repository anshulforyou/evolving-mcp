/**
 * Records the corpus.
 *
 * Runs every (goal, style, params) combination against the real reference
 * sqlite MCP server and writes one JSONL row per call. The sequences are
 * scripted from task definitions rather than produced by a live model, and the
 * report says so. What is real here is the server, the payloads and their
 * sizes, which is what every number in this project is computed from. What is
 * simulated is the caller's choice of sequence.
 *
 * That split matters. It means the token and latency findings stand on their
 * own, while "callers naturally converge on the same path" is a claim this
 * corpus cannot make and does not try to.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { StdioMcpClient } from "../mcp/client.js";
import { normalize, type NormalizedResult } from "../detect/normalize.js";
import { measure } from "../metrics/tokens.js";
import { CALLERS, GOALS } from "./tasks.js";
import type { LabelledCall } from "../types.js";

const DB = process.env["EMCP_DB"] ?? "corpus/store.db";
const OUT = process.env["EMCP_CORPUS"] ?? "corpus/traces.jsonl";

const SERVER_CMD = "uvx";
const SERVER_ARGS = [
  "--quiet", "--from", "mcp-server-sqlite", "--with", "mcp==1.9.4",
  "mcp-server-sqlite", "--db-path", DB,
];

async function main(): Promise<void> {
  const client = new StdioMcpClient(SERVER_CMD, SERVER_ARGS);
  await client.initialize();
  const tools = await client.listTools();
  console.log(`upstream tools: ${tools.map((t) => t.name).join(", ")}`);

  const rows: LabelledCall[] = [];
  let runs = 0;
  let failures = 0;
  let callerIdx = 0;

  for (const goal of GOALS) {
    for (const [styleName, build] of Object.entries(goal.styles)) {
      for (const params of goal.params) {
        const caller = CALLERS[callerIdx++ % CALLERS.length]!;
        const traceId = randomUUID().replace(/-/g, "");
        const steps = build(params);
        const prior: NormalizedResult[] = [];
        const staged: LabelledCall[] = [];
        try {
          for (let i = 0; i < steps.length; i++) {
            const step = steps[i]!;
            const args = step.args(prior);
            const t0 = performance.now();
            const result = await client.callTool(step.tool, args);
            const latencyMs = performance.now() - t0;
            const norm = normalize(result);
            prior.push(norm);
            const { bytes, tokens } = measure(norm.raw);
            const isError =
              typeof result === "object" && result !== null && !Array.isArray(result)
                ? result["isError"] === true
                : false;
            staged.push({
              traceId, seq: i, tsMs: Date.now(), caller,
              tool: step.tool, args, result, isError,
              latencyMs: Math.round(latencyMs * 1000) / 1000,
              resultBytes: bytes, resultTokens: tokens,
              goalId: goal.id, variant: `${styleName}|${JSON.stringify(params)}`,
            });
            if (isError) throw new Error(`upstream error on ${step.tool}: ${norm.raw.slice(0, 200)}`);
          }
          rows.push(...staged);
          runs++;
        } catch (e) {
          failures++;
          console.warn(`  drop ${goal.id}/${styleName} ${JSON.stringify(params)}: ${(e as Error).message}`);
        }
      }
    }
  }
  client.close();

  mkdirSync("corpus", { recursive: true });
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const totalTokens = rows.reduce((a, r) => a + r.resultTokens, 0);
  console.log(
    `\nwrote ${OUT}\n` +
      `  episodes: ${runs} (${failures} dropped)\n` +
      `  calls:    ${rows.length}\n` +
      `  result tokens across corpus: ${totalTokens.toLocaleString()}`,
  );
}

await main();
