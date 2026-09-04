#!/usr/bin/env node
/**
 * evolving-mcp, three commands.
 *
 *   init   introspect a server and write a config skeleton
 *   trace  sit between a client and that server, recording
 *   report say what would be promoted, and what it would save
 *
 * Nothing here promotes anything into a running server. What ships is the
 * measurement: point it at a server you already have and find out what routes
 * your traffic would produce.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StdioMcpClient } from "../mcp/client.js";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../config/load.js";
import { DEFAULT_MINING, DEFAULT_RUNTIME, unclassifiedTools, type Config, type ToolConfig } from "../config/schema.js";
import { RecordingProxy } from "../trace/proxy.js";
import { detect, loadCalls, optionsFor, segment } from "../detect/index.js";
import { select } from "../detect/select.js";
import { activeRoutes, loadStore, saveStore } from "../runtime/store.js";
import { promote } from "../runtime/promote.js";

const USAGE = `evolving-mcp

  evolving-mcp init  [--config <path>] -- <server command...>
  evolving-mcp trace [--config <path>] [--out <file>] [-- <server command...>]
  evolving-mcp report [--config <path>] [--trace <file>]
  evolving-mcp promote [--config <path>] [--trace <file>] [--store <file>]
  evolving-mcp serve  [--config <path>] [--store <file>] [-- <server command...>]

  init    starts your server, reads tools/list, and writes ${DEFAULT_CONFIG_PATH}
          with every tool listed. Tools declaring readOnlyHint are classified
          for you; the rest are marked "unclassified" and need one line each.

  trace   records traffic. Point your MCP client at this instead of at your
          server. Everything is forwarded untouched.

  report  reads the trace and tells you which call sequences recur, what
          collapsing them would save, and what is still unclassified.

  promote turns qualifying routes into entries in the route store, a JSON file
          you review and commit. Nothing is served until you say so.

  serve   the same proxy as \`trace\`, additionally offering the routes in the
          store that you marked active. Your server is untouched.
`;

interface Argv {
  cmd: string;
  flags: Record<string, string>;
  rest: string[];
}

function parseArgv(argv: string[]): Argv {
  const cmd = argv[0] ?? "";
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (afterDoubleDash) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = "true";
      else {
        flags[key] = next;
        i++;
      }
      continue;
    }
    rest.push(a);
  }
  return { cmd, flags, rest };
}

/** The server command, from the flags, else from the config. */
function serverFrom(a: Argv, config: Config | undefined): { command: string; args: string[] } {
  if (a.rest.length) return { command: a.rest[0]!, args: a.rest.slice(1) };
  if (config?.server) return config.server;
  throw new Error("no server command given. Pass it after `--`, or put it in the config under `server`.");
}

/* ------------------------------------------------------------------ */

async function cmdInit(a: Argv): Promise<void> {
  const path = a.flags["config"] ?? DEFAULT_CONFIG_PATH;
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Config) : undefined;
  const server = serverFrom(a, existing);

  const client = new StdioMcpClient(server.command, server.args);
  await client.initialize();
  const tools = await client.listTools();
  client.close();

  const out: Record<string, ToolConfig> = {};
  let annotated = 0;
  for (const t of tools) {
    // Anything the author already decided is kept. `init` is re-runnable when
    // a server grows a tool, and it must never quietly undo a classification.
    const prior = existing?.tools?.[t.name];
    if (prior && prior.mutability !== "unclassified") {
      out[t.name] = prior;
      continue;
    }
    const hint = t.annotations?.readOnlyHint;
    if (hint === true) {
      annotated++;
      out[t.name] = { mutability: "read-only", source: "annotation" };
    } else if (hint === false) {
      annotated++;
      out[t.name] = { mutability: "mutating", source: "annotation" };
    } else {
      out[t.name] = { mutability: "unclassified", source: "default" };
    }
  }

  const config: Config = { version: 1, server, tools: out };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");

  const todo = unclassifiedTools(config);
  console.error(`wrote ${path}`);
  console.error(`  ${tools.length} tools, ${annotated} classified from readOnlyHint annotations`);
  if (todo.length) {
    console.error(`\n  ${todo.length} still need a decision from you. Until then they are treated as`);
    console.error(`  mutating, which means no route will ever skip them:\n`);
    for (const t of todo) console.error(`    ${t}`);
    console.error(`\n  Set each to "read-only" or "mutating" in ${path}.`);
  }
}

function cmdTrace(a: Argv): void {
  const config = loadConfig(a.flags["config"] ?? DEFAULT_CONFIG_PATH);
  const server = serverFrom(a, config);
  const out = a.flags["out"] ?? "evolving-mcp.trace.jsonl";
  const idleGapMs = config?.mining?.idleGapMs ?? DEFAULT_MINING.idleGapMs;

  // Everything the proxy says goes to stderr. stdout is the protocol channel.
  console.error(`evolving-mcp: recording ${server.command} ${server.args.join(" ")} to ${out}`);
  console.error(`evolving-mcp: episodes split on ${idleGapMs}ms of silence unless the client sends a traceparent`);
  new RecordingProxy({ command: server.command, args: server.args, out, idleGapMs });
}

function storePath(a: Argv, config: Config | undefined): string {
  return a.flags["store"] ?? config?.runtime?.store ?? DEFAULT_RUNTIME.store;
}

function cmdPromote(a: Argv): void {
  const config = loadConfig(a.flags["config"] ?? DEFAULT_CONFIG_PATH);
  const tracePath = a.flags["trace"] ?? "evolving-mcp.trace.jsonl";
  const path = storePath(a, config);

  const episodes = segment(loadCalls(tracePath));
  const selections = select(detect(episodes, optionsFor(config)));
  const before = loadStore(path);
  const result = promote(before, selections, config);
  saveStore(path, result.store);

  const mode = config?.runtime?.mode ?? DEFAULT_RUNTIME.mode;
  console.error(`read ${episodes.length} episodes from ${tracePath}`);
  console.error(`wrote ${path}  (${result.store.routes.length} routes, mode: ${mode})\n`);

  for (const r of result.added) {
    console.error(`  + ${r.plan.name}`);
    console.error(`      ${r.evidence.support} episodes, keeps ${r.evidence.tokensSaved.toLocaleString()} tokens out of context`);
    console.error(`      costs ${r.evidence.schemaTokenCost} schema tokens, payoff x${r.evidence.payoffRatio}, skips ${r.evidence.upstreamCallsPruned} upstream calls`);
  }
  for (const r of result.updated) console.error(`  ~ ${r.plan.name}  (evidence refreshed)`);
  for (const r of result.displaced) console.error(`  - ${r.plan.name}  (displaced, surface is capped)`);
  for (const r of result.rejected) console.error(`  x ${r.name}: ${r.why}`);

  if (mode === "propose" && result.added.length) {
    console.error(`\n  These are "proposed" and are NOT served. Review ${path}, and change`);
    console.error(`  "status" to "active" on the ones you want, then run \`serve\`.`);
  }
}

function cmdServe(a: Argv): void {
  const config = loadConfig(a.flags["config"] ?? DEFAULT_CONFIG_PATH);
  const server = serverFrom(a, config);
  const path = storePath(a, config);
  const store = loadStore(path);
  const routes = activeRoutes(store);
  const out = a.flags["out"] ?? "evolving-mcp.trace.jsonl";
  const idleGapMs = config?.mining?.idleGapMs ?? DEFAULT_MINING.idleGapMs;
  const proposed = store.routes.filter((r) => r.status === "proposed").length;

  console.error(`evolving-mcp: serving ${routes.length} route(s) in front of ${server.command} ${server.args.join(" ")}`);
  if (proposed) console.error(`evolving-mcp: ${proposed} more are proposed but not active. Edit ${path} to activate them.`);
  if (!routes.length) console.error(`evolving-mcp: nothing active, so this is behaving exactly like \`trace\``);
  // There is no eviction yet, so nothing here can withdraw a route that starts
  // failing. Say so rather than let somebody discover it.
  if (routes.length) console.error(`evolving-mcp: no eviction in this version. A route that breaks stays until you remove it from ${path}.`);

  new RecordingProxy({ command: server.command, args: server.args, out, idleGapMs, routes });
}

async function main(): Promise<void> {
  const a = parseArgv(process.argv.slice(2));
  switch (a.cmd) {
    case "init":
      await cmdInit(a);
      return;
    case "trace":
      cmdTrace(a);
      return;
    case "promote":
      cmdPromote(a);
      return;
    case "serve":
      cmdServe(a);
      return;
    case "report": {
      process.env["EMCP_CONFIG"] = a.flags["config"] ?? process.env["EMCP_CONFIG"] ?? DEFAULT_CONFIG_PATH;
      process.env["EMCP_CORPUS"] = a.flags["trace"] ?? process.env["EMCP_CORPUS"] ?? "evolving-mcp.trace.jsonl";
      await import("./report.js");
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = a.cmd ? 1 : 0;
  }
}

await main();
