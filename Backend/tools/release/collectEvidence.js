"use strict";

/**
 * Produce release-gate evidence by **running the gates** (§24, §24.7).
 *
 * > Because constraints are pure functions with explicit classes, and because every
 * > decision records which predicates were evaluated with what data, the safety evidence
 * > is a **query rather than a documentation exercise**. (§24.7)
 *
 * Before this tool existed, `cutover/gates.js` held twenty-three gates and nothing in the
 * repository produced evidence for any of them. `req.app.locals.releaseEvidence` was read
 * in two places and assigned in none; the only producers were test fixtures. So the gate
 * table's verdict was whatever object an operator typed, and a hand-written
 * `{ pass: true }` for each of the twenty-three authorised a real cutover. This tool is the
 * producer that was missing.
 *
 * ── What it may and may not close ──────────────────────────────────────────
 * It emits records for `BUILD` and `SUITE` gates **only**. Those are the two kinds
 * `gates.js` says a build can legitimately discharge, and the restriction is enforced twice:
 * this tool does not emit the other kinds, and `evidence.js` would refuse a run record filed
 * against them if it did. A `PRODUCTION` gate needs the fleet to have operated and an
 * `ORGANISATIONAL` gate needs a person to have acted, and no amount of CI substitutes for
 * either. They stay `NOT_EVALUATED` here, which is the honest state and which blocks.
 *
 * The two `ORGANISATIONAL` gates that declare a machine-checkable command
 * (`calibration_safety_derived`, `safety_case_assembled`) get a **corroborating run**
 * recorded under a separate key. A corroboration is not evidence: on its own it discharges
 * nothing, and `evidence.js` requires the two human signatures alongside it. It exists so
 * that an attestation cannot outrank the check it is an attestation about.
 *
 * ── Exit code ───────────────────────────────────────────────────────────────
 * Non-zero when any gate it ran failed. Collecting evidence and *judging* it are separate
 * jobs — `tools/release/verdict.js` does the judging over the whole table — but a collector
 * that exited 0 after watching a gate fail would be one more thing that reports a violation
 * without failing on it.
 *
 * Usage:
 *   node tools/release/collectEvidence.js [--out <file>] [--only build|suite|all] [--json]
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const gates = require("../../src/engine/cutover/gates");
const { sourceDigest } = require("./sourceDigest");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const DEFAULT_OUT = path.join(BACKEND_ROOT, "docs", "release-evidence.json");

/** This tool's identity, carried on every record it writes. */
const PRODUCER = "tools/release/collectEvidence.js";

/**
 * Run one gate command and record what happened.
 *
 * The exit code is captured rather than thrown on, because a failing gate is a result this
 * tool is meant to record, not an error that should abort the collection. Output is
 * captured and truncated: a run record is evidence that something ran and how it ended, and
 * a megabyte of jest output in a JSON file is not more evidence than the tail of it.
 *
 * @param {string} command
 * @param {{ cwd?: string }} [options]
 * @returns {{ command: string, exitCode: number, startedAtMs: number, finishedAtMs: number, tail: string }}
 */
function run(command, options) {
  const cwd = (options && options.cwd) || BACKEND_ROOT;
  const startedAtMs = Date.now();
  let exitCode = 0;
  let output = "";
  try {
    output = execFileSync(command, {
      cwd,
      shell: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // `status` is null when the process was killed by a signal. A gate that was killed did
    // not pass, and reporting 0 for it would be the single worst behaviour here.
    exitCode = typeof error.status === "number" ? error.status : 1;
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  return {
    command,
    exitCode,
    startedAtMs,
    finishedAtMs: Date.now(),
    tail: String(output).slice(-2000),
  };
}

/**
 * Collect evidence for every gate this build may legitimately close.
 *
 * @param {{ only?: string, cwd?: string, runner?: (command: string) => object }} [options]
 * @returns {{ ok: boolean, evidence: object, corroboration: object, ran: object[], sourceDigest: string }}
 */
function collect(options) {
  const settings = options || {};
  const only = settings.only || "all";
  const runner = settings.runner || ((command) => run(command, { cwd: settings.cwd }));

  /**
   * The digest is taken **twice** — before the first gate runs and after the last one —
   * and the collection is void unless they agree.
   *
   * Taking it once, up front, was the first version and it was wrong in a way that only
   * showed up on a long run: a full collection takes ~25 minutes, and any edit during that
   * window produces records that claim a tree state the later gates did not run against.
   * The verdict then refuses all of them with `SOURCE_DIGEST_MISMATCH`, which is the right
   * outcome reached for a confusing reason — the operator reads "evidence about a program
   * nobody is shipping" and has no way to tell an edit-during-collection from a genuine
   * stale artefact.
   *
   * Comparing the endpoints names the condition instead. It is also the stronger check: a
   * gate that passed at minute 2 and a file edited at minute 12 is not evidence about the
   * tree the verdict is taken on, whether or not anybody meant it that way.
   */
  const before = sourceDigest({ root: settings.cwd });

  const wanted = gates.RELEASE_GATES.filter((gate) => {
    const buildLike = gate.evidence === gates.EVIDENCE.BUILD;
    const suiteLike = gate.evidence === gates.EVIDENCE.SUITE;
    const corroborating = gate.runnable === true;
    if (only === "build") return buildLike || corroborating;
    if (only === "suite") return suiteLike;
    return buildLike || suiteLike || corroborating;
  });

  // One execution per distinct command. `chaos_capacity_1` and `chaos_capacity_2` name the
  // same command because the suite runs both capacities internally; running it twice would
  // double the cost and produce two records of the same fact.
  const byCommand = new Map();
  const ran = [];
  for (const gate of wanted) {
    if (!byCommand.has(gate.command)) {
      const result = runner(gate.command);
      byCommand.set(gate.command, result);
      ran.push(result);
    }
  }

  const after = sourceDigest({ root: settings.cwd });
  const treeStable = before.digest === after.digest;
  const digest = after.digest;
  const fileCount = after.fileCount;

  const evidence = {};
  const corroboration = {};
  for (const gate of wanted) {
    const result = byCommand.get(gate.command);
    // When the tree moved under the run, the records are stamped with a digest that matches
    // neither endpoint. They are then refused by `evidence.admit()` against any tree, which
    // is the correct direction: a void collection must not be usable.
    const build = treeStable
      ? { sourceDigest: digest, fileCount }
      : { sourceDigest: `VOID:tree-changed-during-collection:${before.digest.slice(0, 12)}->${after.digest.slice(0, 12)}` };
    if (gate.evidence === gates.EVIDENCE.BUILD || gate.evidence === gates.EVIDENCE.SUITE) {
      evidence[gate.id] = {
        gateId: gate.id,
        producedAtMs: result.finishedAtMs,
        producer: PRODUCER,
        run: { ...result, build },
        build,
      };
    } else {
      // Corroboration only. Deliberately not written into `evidence`: on its own it
      // discharges nothing, and an operator assembling the final evidence file must copy it
      // into a record that also carries the two signatures.
      corroboration[gate.id] = { ...result, build };
    }
  }

  return {
    // A collection whose tree moved is not ok, however the individual gates exited.
    ok: treeStable && ran.every((result) => result.exitCode === 0),
    treeStable,
    sourceDigestBefore: before.digest,
    sourceDigestAfter: after.digest,
    evidence,
    corroboration,
    ran,
    sourceDigest: digest,
  };
}

/**
 * Render for a terminal.
 *
 * @param {ReturnType<typeof collect>} result
 * @returns {string}
 */
function formatReport(result) {
  const lines = result.ran.map(
    (entry) =>
      `  ${entry.exitCode === 0 ? "PASS" : "FAIL"}  ${String(entry.finishedAtMs - entry.startedAtMs).padStart(7)}ms  ` +
      `${entry.command}`,
  );
  const produced = Object.keys(result.evidence).length;
  const corroborated = Object.keys(result.corroboration).length;
  const void_ =
    result.treeStable === false
      ? `\n  VOID — the source tree changed while the gates were running ` +
        `(${result.sourceDigestBefore.slice(0, 12)} → ${result.sourceDigestAfter.slice(0, 12)}). ` +
        `Every record is stamped unusable. Re-run the collection on a tree nobody is editing.`
      : "";
  return (
    `release evidence (§24) — produced by running the gates, not by asserting them\n` +
    `  source digest ${result.sourceDigest.slice(0, 16)}…\n` +
    `${lines.join("\n")}\n` +
    `  ${produced} gate record(s), ${corroborated} corroborating run(s). ` +
    `PRODUCTION and ORGANISATIONAL gates are not closable here and remain NOT_EVALUATED.${void_}`
  );
}

module.exports = { PRODUCER, DEFAULT_OUT, run, collect, formatReport };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const at = (flag) => {
    const index = argv.indexOf(flag);
    return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
  };
  const only = at("--only") || "all";
  const out = at("--out") || DEFAULT_OUT;

  const result = collect({ only });
  const document = {
    schema: "robotx.release-evidence.v1",
    producedAtMs: Date.now(),
    producer: PRODUCER,
    sourceDigest: result.sourceDigest,
    only,
    evidence: result.evidence,
    corroboration: result.corroboration,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);

  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${formatReport(result)}\n  written to ${path.relative(BACKEND_ROOT, out)}\n`);

  process.exitCode = result.ok ? 0 : 1;
}
