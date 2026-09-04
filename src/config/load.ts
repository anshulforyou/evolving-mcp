import { existsSync, readFileSync } from "node:fs";
import { parseConfig, ConfigError, type Config } from "./schema.js";

export const DEFAULT_CONFIG_PATH = "evolving-mcp.json";

/**
 * Loads the config, or returns undefined when there is none.
 *
 * Absence is legal and means the safe default everywhere: no tool is known to
 * be read-only, so nothing is pruned. A config that exists but is malformed is
 * NOT legal and throws, because silently falling back to defaults would turn a
 * typo into a disabled safety rule.
 */
export function loadConfig(path = process.env["EMCP_CONFIG"] ?? DEFAULT_CONFIG_PATH): Config | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${path}: not valid JSON (${(e as Error).message})`);
  }
  return parseConfig(raw, path);
}
