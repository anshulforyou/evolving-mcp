/**
 * Discrete-argument corpus, against the reference filesystem server.
 *
 * The point of contrast with phase 1. There the tool took one free-form SQL
 * string and a model asked the same question six ways wrote six different
 * queries, which lexical clustering could not see through. Here the tool takes
 * a `path`, so if two callers with the same intent land on the same file, their
 * arguments are byte-identical and there is nothing to normalize at all.
 *
 * The model still makes the decision that matters: given a real listing, which
 * file answers this question. That is where variation would show up if it is
 * going to.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { StdioMcpClient } from "../mcp/client.js";
import { looksLikeError, normalize, type NormalizedResult } from "../detect/normalize.js";
import { measure } from "../metrics/tokens.js";
import { askToPickPath, cacheStats, flushCache } from "./llm.js";
import { CALLERS } from "./tasks.js";
import type { Json, LabelledCall } from "../types.js";

const ROOT = resolve(process.env["EMCP_TREE"] ?? "corpus/tree");
const OUT = process.env["EMCP_CORPUS_FS"] ?? "corpus/traces-fs.jsonl";
const SUBDIRS = ["src", "src/auth", "src/db", "tests", "config", "docs"];

/**
 * Exploration styles.
 *
 * `tree` takes one call to see everything, then checks the file before reading
 * it. `walk` lists the root and then each subdirectory, six calls to assemble
 * the same picture, and reads without checking.
 *
 * Different tools, different lengths, same information, and if the model lands
 * on the same file both ways then the same outcome. That is the case the merge
 * step exists for, and until now no corpus contained it.
 */
type Style = "tree" | "walk";

interface FsGoal {
  id: string;
  paraphrases: string[];
  styles: Record<string, Style>;
}

const GOALS: FsGoal[] = [
  {
    id: "read_auth_module",
    paraphrases: [
      "Show me the code that resolves who the caller is.",
      "Which file works out the current user from a request? Open it.",
      "I want to read our session handling logic.",
    
      "Find where we verify a bearer token belongs to someone, and print that file.",
      "Pull up the module responsible for identifying the requester.",
      "Read me whatever handles authentication state.",
      "Open the source file dealing with user sessions.",],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_db_pool",
    paraphrases: [
      "Open the file that sets up the database connection.",
      "Where do we create the connection pool? Show me that file.",
      "I need to see how we connect to Postgres.",
    
      "Read the module that opens our Postgres pool.",
      "Find the file responsible for database connectivity and show it.",
      "Which source file manages the shared db connection? Print it.",
      "Open whatever sets up our database client.",],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_prod_config",
    paraphrases: [
      "Show me the production configuration.",
      "Open the config we use in prod.",
      "I want to check the production settings file.",
    
      "Read the settings file used when running in production.",
      "Find the prod environment config and print it out.",
      "Which config applies to the live deployment? Show me.",
      "Open the production JSON config.",],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_orders_test",
    paraphrases: [
      "Open the test file covering orders.",
      "Show me the tests for the orders route.",
      "Which test exercises order handling? Read it out.",
    
      "Find the spec file for orders and read it.",
      "Print the unit tests that cover the orders endpoint.",
      "Which file tests order behaviour? Open it.",
      "Read the orders test suite.",],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_deploy_doc",
    paraphrases: [
      "Show me the deployment instructions.",
      "Open the doc explaining how we ship this.",
      "I want to read the deploy runbook.",
    
      "Find the documentation describing our release process.",
      "Read the markdown file about deploying.",
      "Which doc covers rollout steps? Print it.",
      "Open the deployment guide.",],
    styles: { tree: "tree", walk: "walk" },
  },
];

async function main(): Promise<void> {
  const client = new StdioMcpClient("npx", ["-y", "@modelcontextprotocol/server-filesystem", ROOT]);
  await client.initialize();

  const rows: LabelledCall[] = [];
  let episodes = 0, dropped = 0, callerIdx = 0;

  for (const goal of GOALS) {
    for (const [styleName, mode] of Object.entries(goal.styles)) {
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
          let listing: string;
          if (mode === "tree") {
            listing = (await emit("directory_tree", { path: ROOT })).raw;
          } else {
            const root = await emit("list_directory", { path: ROOT });
            const parts = [root.raw];
            for (const dir of SUBDIRS) {
              parts.push(`${dir}/\n` + (await emit("list_directory", { path: resolve(ROOT, dir) })).raw);
            }
            listing = parts.join("\n");
          }

          const picked = (
            await askToPickPath(
              `Files available:\n${listing.slice(0, 4000)}\n\nRequest: ${question}\n\nReply with the single absolute path that answers it.`,
            )
          ).trim();
          const path = picked.startsWith("/") ? picked : resolve(ROOT, picked);
          if (mode === "tree") await emit("get_file_info", { path });
          await emit("read_text_file", { path });

          rows.push(...staged);
          episodes++;
        } catch (e) {
          dropped++;
          console.warn(`  drop ${goal.id}/${styleName}: ${(e as Error).message.slice(0, 140)}`);
        }
      }
    }
  }
  client.close();
  flushCache();

  mkdirSync("corpus", { recursive: true });
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const st = cacheStats();
  console.log(`\nwrote ${OUT}\n  episodes: ${episodes} (${dropped} dropped)\n  calls: ${rows.length}\n  model: ${st.calls} live, ${st.hits} cached`);
}

await main();
