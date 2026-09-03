/**
 * Phase 1 corpus: the queries are written by a model, not by me.
 *
 * Everything else is held constant against phase 0 on purpose. Same server,
 * same database, same goals, same exploration styles, same detector. The only
 * variable changed is who writes the SQL, so the difference between the two
 * reports isolates exactly one thing: whether skeleton clustering survives the
 * natural variation a model introduces when asked the same question in
 * different words.
 *
 * The model sees the real schema, recovered from the describe_table calls the
 * episode actually made, which is what an agent would have had.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { StdioMcpClient } from "../mcp/client.js";
import { looksLikeError, normalize, type NormalizedResult } from "../detect/normalize.js";
import { measure } from "../metrics/tokens.js";
import { askForSql, cacheStats, flushCache } from "./llm.js";
import { CALLERS } from "./tasks.js";
import type { Json, LabelledCall } from "../types.js";

const DB = process.env["EMCP_DB"] ?? "corpus/store.db";
const OUT = process.env["EMCP_CORPUS_LLM"] ?? "corpus/traces-llm.jsonl";

interface LlmGoal {
  id: string;
  /** The same request, worded the way different people would word it. */
  paraphrases: string[];
  /** Exploration styles: which tables this caller inspected before querying. */
  styles: Record<string, string[]>;
  /** A second question that depends on the first answer, or absent. */
  followUp?: string;
}

const GOALS: LlmGoal[] = [
  {
    id: "invoices_for_customer",
    paraphrases: [
      "Show me the invoices for the customer whose last name is Cruz.",
      "I need every invoice belonging to a customer surnamed Cruz.",
      "Pull up billing history for the Cruz account.",
    ],
    styles: { inspect_both: ["customers", "invoices"], invoices_first: ["invoices"] },
  },
  {
    id: "albums_by_artist",
    paraphrases: [
      "Which albums did the artist called Copper Riot put out?",
      "List every record released by Copper Riot.",
      "What is in the Copper Riot discography?",
    ],
    styles: { inspect_both: ["artists", "albums"], albums_first: ["albums", "artists"] },
  },
  {
    id: "top_customers_by_spend",
    paraphrases: [
      "Who are our ten highest spending customers?",
      "Rank customers by total money spent and give me the top ten.",
      "I want the ten biggest accounts by revenue.",
    ],
    styles: { inspect_both: ["customers", "invoices"], invoices_first: ["invoices"] },
  },
  {
    id: "revenue_by_country",
    paraphrases: [
      "How much revenue came from each country?",
      "Break down total sales by country.",
      "Give me a per-country revenue summary.",
    ],
    styles: { direct: ["invoices"], via_customers: ["customers", "invoices"] },
  },
  {
    id: "tracks_longer_than",
    paraphrases: [
      "Which tracks run longer than seven minutes?",
      "Find songs over seven minutes long.",
      "Show me anything with a runtime above seven minutes.",
    ],
    styles: { direct: ["tracks"], with_album: ["tracks", "albums"] },
  },
  {
    id: "tracks_per_genre",
    paraphrases: [
      "How many tracks are in each genre?",
      "Count the songs per genre.",
      "Give me a genre by genre track count.",
    ],
    styles: { inspect_both: ["tracks", "genres"], tracks_first: ["tracks"] },
  },
  {
    id: "customers_without_invoices",
    paraphrases: [
      "Which customers have never bought anything?",
      "Find accounts with no purchase history at all.",
      "List customers who have never been invoiced.",
    ],
    styles: { inspect_both: ["customers", "invoices"], customers_first: ["customers"] },
  },
  {
    id: "top_tracks_by_revenue",
    paraphrases: [
      "Which tracks earned the most money? Top fifteen.",
      "Rank songs by revenue and show the top fifteen.",
      "What are our fifteen best selling tracks by value?",
    ],
    styles: { direct: ["invoice_items", "tracks"], items_first: ["invoice_items"] },
  },
];

const schemaBlock = (tables: string[], results: NormalizedResult[]): string =>
  tables.map((t, i) => `${t}: ${results[i + 1]?.raw ?? "(unavailable)"}`).join("\n");

async function main(): Promise<void> {
  const client = new StdioMcpClient("uvx", [
    "--quiet", "--from", "mcp-server-sqlite", "--with", "mcp==1.9.4",
    "mcp-server-sqlite", "--db-path", DB,
  ]);
  await client.initialize();

  const rows: LabelledCall[] = [];
  let episodes = 0, dropped = 0, callerIdx = 0;

  for (const goal of GOALS) {
    for (const [styleName, tables] of Object.entries(goal.styles)) {
      for (const question of goal.paraphrases) {
        const caller = CALLERS[callerIdx++ % CALLERS.length]!;
        const traceId = randomUUID().replace(/-/g, "");
        const prior: NormalizedResult[] = [];
        const staged: LabelledCall[] = [];
        let seq = 0;

        const emit = async (tool: string, args: Json): Promise<NormalizedResult> => {
          const t0 = performance.now();
          const result = await client.callTool(tool, args);
          const latencyMs = performance.now() - t0;
          const norm = normalize(result);
          prior.push(norm);
          const { bytes, tokens } = measure(norm.raw);
          const flagged =
            typeof result === "object" && result !== null && !Array.isArray(result)
              ? result["isError"] === true
              : false;
          const isError = looksLikeError(result, flagged);
          staged.push({
            traceId, seq: seq++, tsMs: Date.now(), caller, tool, args, result, isError,
            latencyMs: Math.round(latencyMs * 1000) / 1000,
            resultBytes: bytes, resultTokens: tokens,
            goalId: goal.id, variant: `${styleName}|${question.slice(0, 40)}`,
          });
          if (isError) throw new Error(`upstream error on ${tool}: ${norm.raw.slice(0, 160)}`);
          return norm;
        };

        try {
          await emit("list_tables", {});
          for (const t of tables) await emit("describe_table", { table_name: t });

          const sql = await askForSql(
            `SQLite schema (from PRAGMA table_info):\n${schemaBlock(tables, prior)}\n\nRequest: ${question}\n\nWrite one SELECT query that answers it.`,
          );
          await emit("read_query", { query: sql });

          if (goal.followUp) {
            const sql2 = await askForSql(
              `SQLite schema:\n${schemaBlock(tables, prior)}\n\nThe query\n${sql}\nreturned:\n${prior[prior.length - 1]!.raw.slice(0, 600)}\n\nFollow-up request: ${goal.followUp}\n\nWrite one SELECT query.`,
            );
            await emit("read_query", { query: sql2 });
          }

          rows.push(...staged);
          episodes++;
        } catch (e) {
          dropped++;
          console.warn(`  drop ${goal.id}/${styleName}: ${(e as Error).message}`);
        }
      }
    }
  }
  client.close();
  flushCache();

  mkdirSync("corpus", { recursive: true });
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const stats = cacheStats();
  console.log(
    `\nwrote ${OUT}\n` +
      `  episodes: ${episodes} (${dropped} dropped)\n` +
      `  calls:    ${rows.length}\n` +
      `  model:    ${stats.calls} live calls, ${stats.hits} cache hits, ${stats.entries} cached`,
  );
}

await main();
