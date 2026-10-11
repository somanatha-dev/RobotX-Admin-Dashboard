"use strict";

/**
 * The identity of the code this process runs — the `codeVersion` pin §9.6 requirement 6 and
 * §21.2's Versions row require every round snapshot to carry.
 *
 * `determinism/snapshot.captureSnapshot` refuses a snapshot without one, and until P7-D5 Step 1
 * nothing in the backend produced one, so no round snapshot was ever captured: every
 * `InputSnapshot` row carried an empty hash and no versions.
 *
 * Resolved ONCE, at boot, by the composition root, in this order:
 *
 *   1. `RENDER_GIT_COMMIT` — the commit the hosting platform built this deploy from. Reported
 *      as `git:<sha>`. A value that is not a hex commit id is ignored, never trusted as-is.
 *   2. Otherwise a content digest of the backend's own source — `server.js` and every
 *      `src/**\/*.js`, by sorted relative path and exact bytes — reported as
 *      `src-sha256:<hex>`. It names the code actually loaded, uncommitted edits included,
 *      which a commit id on a dirty working tree would not.
 *   3. Otherwise `null`. No identity is invented: the snapshot is then not captured, and the
 *      round records that it ran unpinned (see `coordinator.worker.pinRoundInputs`).
 *
 * The digest is computed from the files on disk at boot. A file edited afterwards is not
 * the code this process loaded, so re-reading later would be the wrong answer, not a fresher one.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** A git commit id as platforms report it: 7–40 hex digits. @structural */
const COMMIT_ID = /^[0-9a-f]{7,40}$/i;

/** @structural the digest algorithm and the prefixes that name each source */
const DIGEST_ALGORITHM = "sha256";
const SOURCE = Object.freeze({ PLATFORM_COMMIT: "PLATFORM_COMMIT", SOURCE_DIGEST: "SOURCE_DIGEST", NONE: "NONE" });

/**
 * P7-D5 D7 — what each kind of `codeVersion` does and does not identify, stated once, beside the
 * code that produces it. A decision record carries this so its `codeVersion` is self-describing:
 * it is a SOURCE identity, never a build or runtime identity. If `sourceDigest` is ever widened,
 * this statement must change with it (`tests/engine/p7d5CodeIdentity.test.js` ties the two).
 * @structural fixed coverage statements, not tunables
 */
const SCOPE = Object.freeze({
  PLATFORM_COMMIT:
    "the repository commit the hosting platform reported building (tracked files at that commit); " +
    "excludes installed dependencies (node_modules), environment variables and the Node.js runtime",
  SOURCE_DIGEST:
    "server.js and src/**/*.js only, by relative path, length and bytes; excludes non-JS files under src " +
    "(the parameter register JSON), package.json, package-lock.json, prisma/, tools/ (including replay), " +
    "node_modules, environment variables and the Node.js runtime",
});

/** The exact shapes `resolveCodeVersion` produces. @structural */
const PLATFORM_COMMIT_VERSION = /^git:[0-9a-f]{7,40}$/;
const SOURCE_DIGEST_VERSION = /^src-sha256:[0-9a-f]{64}$/;

/**
 * Every `.js` file under `dir`, as POSIX paths relative to `root`.
 *
 * @param {object} fsImpl
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
function jsFilesUnder(fsImpl, root, dir) {
  const out = [];
  for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(fsImpl, root, full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

/**
 * The content digest of `server.js` plus `src/**\/*.js` under `root`.
 *
 * Each file contributes its relative path, its byte length and its bytes, so a rename, a
 * move and an edit all change the digest, and two files cannot run together into one.
 *
 * @param {string} root the backend directory
 * @param {object} [fsImpl] injected for tests
 * @returns {{ ok: boolean, digest: string|null, files: number, problems: string[] }}
 */
function sourceDigest(root, fsImpl) {
  const io = fsImpl || fs;
  try {
    const files = jsFilesUnder(io, root, path.join(root, "src"));
    if (io.existsSync(path.join(root, "server.js"))) files.push("server.js");
    if (files.length === 0) return { ok: false, digest: null, files: 0, problems: ["no source files were found to digest"] };
    // Code-unit order, not locale order: two hosts must sort the same list the same way.
    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const hash = crypto.createHash(DIGEST_ALGORITHM);
    for (const relative of files) {
      const bytes = io.readFileSync(path.join(root, relative));
      hash.update(`${relative}\n${bytes.length}\n`);
      hash.update(bytes);
      hash.update("\n");
    }
    return { ok: true, digest: hash.digest("hex"), files: files.length, problems: [] };
  } catch (error) {
    return { ok: false, digest: null, files: 0, problems: [`the source digest could not be computed: ${error && error.message}`] };
  }
}

/**
 * Resolve this process's code version.
 *
 * @param {object} [options]
 * @param {object} [options.env] defaults to `process.env`
 * @param {string} [options.root] the backend directory; defaults to the one this module is in
 * @param {object} [options.fs] injected for tests
 * @returns {{ codeVersion: string|null, source: string, problems: string[] }}
 */
function resolveCodeVersion(options) {
  const settings = options || {};
  const env = settings.env || process.env;
  const root = settings.root || path.resolve(__dirname, "..", "..");
  const problems = [];

  const commit = typeof env.RENDER_GIT_COMMIT === "string" ? env.RENDER_GIT_COMMIT.trim() : "";
  if (commit !== "") {
    if (COMMIT_ID.test(commit)) return { codeVersion: `git:${commit.toLowerCase()}`, source: SOURCE.PLATFORM_COMMIT, problems };
    problems.push("RENDER_GIT_COMMIT is set but is not a hex commit id; it was ignored");
  }

  const digest = sourceDigest(root, settings.fs);
  if (digest.ok) return { codeVersion: `src-sha256:${digest.digest}`, source: SOURCE.SOURCE_DIGEST, problems };

  return { codeVersion: null, source: SOURCE.NONE, problems: [...problems, ...digest.problems] };
}

/**
 * P7-D5 D7 — which kind of identity a `codeVersion` string is, and what it covers.
 *
 * Pure and non-throwing. Only the two shapes `resolveCodeVersion` produces are recognised —
 * `git:<7–40 lower-case hex>` and `src-sha256:<64 lower-case hex>`. Anything else (null, a
 * non-string, an empty or unprefixed label such as `"c"` or `"code-1"`, a malformed prefix) is
 * `NONE` with no scope: an identity whose coverage cannot be stated is not described as having one.
 *
 * @param {*} codeVersion
 * @returns {{ source: string, scope: string|null }}
 */
function describeCodeVersion(codeVersion) {
  if (typeof codeVersion !== "string") return { source: SOURCE.NONE, scope: null };
  if (PLATFORM_COMMIT_VERSION.test(codeVersion)) return { source: SOURCE.PLATFORM_COMMIT, scope: SCOPE.PLATFORM_COMMIT };
  if (SOURCE_DIGEST_VERSION.test(codeVersion)) return { source: SOURCE.SOURCE_DIGEST, scope: SCOPE.SOURCE_DIGEST };
  return { source: SOURCE.NONE, scope: null };
}

module.exports = { SOURCE, SCOPE, resolveCodeVersion, sourceDigest, describeCodeVersion };
