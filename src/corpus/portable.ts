/**
 * Machine-independent paths in the corpus.
 *
 * The filesystem server takes absolute paths, so a recorded trace would carry
 * whoever's home directory it was recorded under. That is a privacy leak in a
 * public repo and, worse, it makes the corpus unreproducible: another person
 * running `npm run record:fs` writes different traces, and the routes mined
 * from them carry a path that exists on exactly one machine.
 *
 * So the corpus stores a sentinel and it is expanded again at the moment a
 * route actually runs.
 */
import { resolve } from "node:path";

export const TREE_SENTINEL = "{TREE}";

export const treeRoot = (): string => resolve(process.env["EMCP_TREE"] ?? "corpus/tree");

/** Absolute local paths become the sentinel, for anything written to disk. */
export function toPortable<T>(value: T, root = treeRoot()): T {
  return JSON.parse(JSON.stringify(value).split(root).join(TREE_SENTINEL)) as T;
}

/** The sentinel becomes a real path again, for anything sent to a server. */
export function fromPortable<T>(value: T, root = treeRoot()): T {
  return JSON.parse(JSON.stringify(value).split(TREE_SENTINEL).join(root)) as T;
}
