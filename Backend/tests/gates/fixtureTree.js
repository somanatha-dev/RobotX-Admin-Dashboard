"use strict";

/**
 * Helper for the build-gate self-tests.
 *
 * A gate that has never failed is not known to work. Each gate self-test therefore
 * materialises a small source tree containing a *deliberately planted* violation,
 * runs the real gate against it, and asserts the gate reports it — then runs the
 * compliant variant of the same tree and asserts it passes. Testing only the
 * compliant case would pass equally well against a gate that returns `ok: true`
 * unconditionally, which is the failure mode that matters.
 *
 * Fixtures use **real engine module paths** so that the real `MODULE_TIERS` table
 * applies. A fixture that invented its own tier map would test the checker's plumbing
 * rather than the tier assignment the programme actually relies on.
 *
 * Trees are written under `tests/gates/.fixtures/` (git-ignored) and removed after
 * each test.
 */

const fs = require("fs");
const path = require("path");

const FIXTURE_ROOT = path.join(__dirname, ".fixtures");

/**
 * Materialise a source tree.
 *
 * @param {string} name unique directory name for this fixture
 * @param {Record<string, string>} files map of tree-relative POSIX path → contents
 * @returns {string} absolute path to the tree root
 */
function createTree(name, files) {
  const root = path.join(FIXTURE_ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });

  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, "utf8");
  }

  return root;
}

/**
 * Remove a fixture tree.
 *
 * @param {string} root absolute path returned by `createTree`
 */
function removeTree(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Remove every fixture tree, including any left behind by an interrupted run.
 */
function removeAllTrees() {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
}

module.exports = { FIXTURE_ROOT, createTree, removeTree, removeAllTrees };
