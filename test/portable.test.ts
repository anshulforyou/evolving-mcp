import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fromPortable, toPortable, TREE_SENTINEL } from "../src/corpus/portable.js";

test("nothing tracked in this repo carries an absolute home path", () => {
  // 391 of these were committed before anyone noticed. It leaks whoever
  // recorded the corpus, and it makes the corpus reproducible on exactly one
  // machine, which defeats the point of committing it.
  const files = execSync("git ls-files", { encoding: "utf8" }).trim().split("\n");
  const offenders = files.filter((f) => {
    try {
      return /\/(Users|home)\/[a-z][a-z0-9_-]*\//i.test(readFileSync(f, "utf8"));
    } catch {
      return false; // binary or unreadable
    }
  });
  assert.deepEqual(offenders, [], `absolute home paths found in: ${offenders.join(", ")}`);
});

test("a portable path round-trips back to the real one", () => {
  const root = "/somewhere/corpus/tree";
  const args = { path: `${root}/src/db/pool.js`, nested: [{ p: `${root}/docs` }] };
  const portable = toPortable(args, root);
  assert.equal(portable.path, `${TREE_SENTINEL}/src/db/pool.js`);
  assert.deepEqual(fromPortable(portable, root), args);
});

test("a path that was never under the tree is left alone", () => {
  const v = { path: "/etc/hosts" };
  assert.deepEqual(toPortable(v, "/somewhere/corpus/tree"), v);
});
