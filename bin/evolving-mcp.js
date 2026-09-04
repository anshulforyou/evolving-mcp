#!/usr/bin/env node
// tsx runs the TypeScript entry point directly, so there is no build step and
// no compiled output that can drift from the source people are reading.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/cli/main.ts");
const r = spawnSync(process.execPath, [resolve(here, "../node_modules/tsx/dist/cli.mjs"), entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
