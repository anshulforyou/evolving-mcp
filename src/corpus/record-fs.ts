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
import { fromPortable, toPortable } from "./portable.js";
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
  {
    id: "read_migrations",
    paraphrases: [
      "Show me the file that defines our database migrations.",
      "Open whatever lists the schema changes.",
      "Where are the migrations declared? Print that file.",
      "I want to see the list of SQL migrations we apply.",
      "Read the module holding our schema change history.",
      "Find the file describing database structure changes and open it.",
      "Which source file enumerates our migrations?",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_money_lib",
    paraphrases: [
      "Open the helper that formats currency amounts.",
      "Show me the module dealing with money.",
      "Which file handles amount formatting? Read it.",
      "I need to see how we represent monetary values.",
      "Find the currency utility and print it.",
      "Read the code that turns minor units into a display string.",
      "Open our money helper module.",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_retry_lib",
    paraphrases: [
      "Show me the retry helper.",
      "Open the module that retries a failing operation.",
      "Which file implements retry logic? Print it.",
      "I want to read how we handle transient failures.",
      "Find the utility that reattempts a function and open it.",
      "Read our backoff or retry code.",
      "Open the helper wrapping a call in retries.",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_health_route",
    paraphrases: [
      "Open the health check endpoint.",
      "Show me the code behind our health route.",
      "Which file serves the liveness endpoint? Read it.",
      "I want to see the health handler.",
      "Find the route returning ok and print it.",
      "Read the module implementing /health.",
      "Open the healthcheck handler source.",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_staging_config",
    paraphrases: [
      "Show me the staging configuration.",
      "Open the config used in staging.",
      "I want to check the staging environment settings.",
      "Which config applies to our staging deploy? Print it.",
      "Read the non-production settings file.",
      "Open the staging JSON config.",
      "Find the configuration for the staging environment.",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_architecture_doc",
    paraphrases: [
      "Show me the architecture documentation.",
      "Open the doc explaining how the system fits together.",
      "I want to read the architecture overview.",
      "Which document describes the request flow? Print it.",
      "Read the high level design notes.",
      "Find the markdown file about system structure.",
      "Open the architecture write-up.",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_package_manifest",
    paraphrases: [
      "Show me the package manifest.",
      "Open the file declaring our dependencies and entry point.",
      "I want to see the npm package definition.",
      "Which file holds the project name and version? Read it.",
      "Print the package descriptor.",
      "Find the manifest listing the main entry.",
      "Open our package metadata file.",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_server_entry",
    paraphrases: [
      "Open the application entry point.",
      "Show me where the server starts up.",
      "Which file boots the service? Read it.",
      "I want to see the startup code.",
      "Find the module that starts listening and print it.",
      "Read the main server file.",
      "Open the code that launches the app.",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_router",
    paraphrases: [
      "Show me where routes are wired together.",
      "Open the router definition.",
      "Which file maps paths to handlers? Print it.",
      "I want to read the routing table.",
      "Find the module assembling our routes and open it.",
      "Read the code that builds the router.",
      "Open the route registry.",
    ],
    styles: { tree: "tree", walk: "walk" },
  },
  {
    id: "read_money_test",
    paraphrases: [
      "Open the tests for the money helper.",
      "Show me the currency formatting tests.",
      "Which test file covers amounts? Read it.",
      "I want to see the money unit tests.",
      "Find the spec exercising currency formatting.",
      "Read the test suite for monetary values.",
      "Open the tests covering our money module.",
    ],
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
            // Written portable: no machine's home directory belongs in a
            // corpus other people are expected to reproduce.
            traceId, seq: seq++, tsMs: Date.now(), caller,
            tool, args: toPortable(args), result: toPortable(result), isError,
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
              // The prompt is normalized too, so the response cache is keyed on
              // something identical across machines and a clone spends nothing.
              toPortable(`Files available:\n${listing.slice(0, 4000)}\n\nRequest: ${question}\n\nReply with the single absolute path that answers it.`),
            )
          ).trim();
          const path = picked.startsWith("{") ? fromPortable(picked) : picked.startsWith("/") ? picked : resolve(ROOT, picked);
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
