"use strict";

/**
 * The identity of the tree a gate ran against.
 *
 * A build gate's result is a fact about a particular source state and nothing else, so a
 * run record that does not name that state can be replayed against any later tree. The
 * cheapest attack on a build gate is to satisfy it, collect the evidence, and then restore
 * the file the gate was complaining about; binding every run record to a digest of the
 * tracked source is what makes that attack visible instead of invisible.
 *
 * ── Why a content digest and not the git commit ────────────────────────────
 * A commit id names a tree only when the worktree is clean, and the worktree is exactly
 * where a cutover is prepared. Hashing the files themselves answers the question that
 * actually matters — "is this the code the gate ran against" — without depending on
 * whether anybody remembered to commit.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * `src/`, `tools/`, `tests/`, the parameter register, `package.json` and `jest.config.js`.
 * That is the set whose contents can change what a gate concludes. Documentation is
 * deliberately outside it: a gate's verdict must not change because a runbook was reworded,
 * and a digest that moved on every prose edit would train its readers to re-collect
 * evidence without reading why.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

/** @structural the directories whose contents can change a gate's verdict */
const SCOPE_DIRECTORIES = Object.freeze(["src", "tools", "tests"]);

/** @structural single files in scope for the same reason */
const SCOPE_FILES = Object.freeze(["package.json", "jest.config.js"]);

/** Directory names never descended into. */
const SKIP = Object.freeze(new Set(["node_modules", ".git", "coverage"]));

function walk(directory, collected) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, collected);
    else if (entry.isFile()) collected.push(full);
  }
  return collected;
}

/**
 * A stable digest over the in-scope source.
 *
 * Paths are relativised and sorted so the digest does not depend on where the repository
 * sits or on the order the filesystem happened to return, and each file contributes its
 * path as well as its bytes so that renaming a file changes the digest.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ digest: string, fileCount: number }}
 */
function sourceDigest(options) {
  const root = (options && options.root) || BACKEND_ROOT;
  const files = [];
  for (const directory of SCOPE_DIRECTORIES) walk(path.join(root, directory), files);
  for (const file of SCOPE_FILES) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) files.push(full);
  }

  const relative = files.map((file) => path.relative(root, file).split(path.sep).join("/")).sort();
  const hash = crypto.createHash("sha256");
  for (const rel of relative) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), fileCount: relative.length };
}

module.exports = { SCOPE_DIRECTORIES, SCOPE_FILES, sourceDigest };

if (require.main === module) {
  const result = sourceDigest();
  process.stdout.write(`${result.digest}  (${result.fileCount} files)\n`);
}
