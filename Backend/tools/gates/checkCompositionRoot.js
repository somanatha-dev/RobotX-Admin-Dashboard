"use strict";

/**
 * BUILD GATE — every worker the registry declares as production-scheduled is actually
 * reachable from the composition root (execution plan, Phase 15).
 *
 * > **PHASE 15** — All engine workers move from shadow to production scheduling.
 *
 * ── The defect this gate exists to catch ───────────────────────────────────
 * `src/workers/registry.js` classifies nineteen workers into three readiness states, and
 * its own header makes the contract explicit for one of them:
 *
 * > `blockedBy` is mandatory on a `DEFERRED` row and `assertRegistry()` refuses a row
 * > without it, for the same reason `@structural` demands a reason: an unexplained
 * > exemption is how a register rots.
 *
 * Nothing held the other two columns to any standard at all. `SCHEDULED` and `LEADER_ONLY`
 * are claims that this process starts a worker, and no check anywhere compared those claims
 * against the composition root. The result, found during the Phase 15 remediation:
 *
 *   **All four `LEADER_ONLY` workers — `coordinator`, `outbox`, `reconciler`, `timer` — are
 *   required by nothing outside tests.**
 *
 * `coordinator.worker.js` is Tier 0: "The round loop: drain the queue, generate, gate,
 * price, solve, commit." Its own `start()` docstring says "Not called from `server.js`:
 * `ENGINE_ENABLED` is false and Phase 15 owns moving engine workers from shadow to
 * production scheduling", and the other three say the same. `server.js` says they "belong to
 * the shard supervisor's leadership lifecycle"; `shardSupervisor.worker.js` has no promotion
 * hook and starts none of them.
 *
 * So `ENGINE_ENABLED=true` would take a shard live onto a decision path that never
 * executes — tasks accepted, nothing assigned, nothing dispatched, no timers, no
 * reconciliation. The entire test suite passes because every test drives `runRound()` and
 * `runOnce()` directly with a hand-built dependency object, which is exactly the shape of
 * defect this programme has hit before: a mechanism written, tested, and never called.
 *
 * ── What the remediation found, and how this gate had to change ────────────
 * "Required by nothing outside tests" turned out to be two different findings wearing one
 * name, and the first version of this gate could not tell them apart.
 *
 * `workers/leaderWorkers.js` is now the shard supervisor's promotion hook, and it starts
 * **two** of the four: `outbox` (whose delivery arm is `commandDispatcher.outboxDeliveryArm`,
 * production code that already exists — and whose absence meant `membership.migrate()` had
 * been enqueuing `SHARD_MIGRATE` rows nothing ever delivered) and `reconciler` (whose three
 * collaborators `server.js` already builds for the failover path).
 *
 * The other two are **not** wiring gaps and no commit in this repository closes them:
 *
 *   - `coordinator` needs `expandCandidates` / `pricedCandidateFor`, which bottom out in an
 *     injected `route` function — the routing engine. **B1 has selected none**, and its
 *     Step 5 is blocked on D1, D3 and D8, which are Operations, Product and Commercial
 *     decisions.
 *   - `timer` needs a `handlers` map keyed by the §4.3/§4.2 expiry action. Sixteen actions
 *     are declared and **none is implemented** anywhere under `src/`.
 *
 * Reporting those as `LEADER_ONLY_UNREACHABLE` invited the wrong repair: require the module,
 * turn the gate green, and start a worker that runs and decides wrongly. So the gate now
 * asks a second, sharper question and reports `LEADER_ONLY_NOT_COMPOSABLE` with the blocker
 * and its owner.
 *
 * ── Why a build gate ────────────────────────────────────────────────────────
 * The wiring half *is* a defect a commit can fix, so it blocks the build in the same lane as
 * the other structural gates. It fails today, and that is the honest state — the alternative
 * is a green build over an engine that does not run. That two of its remaining findings name
 * external owners does not make them less blocking; it makes them non-negotiable by this
 * repository, which is a stronger statement and not a weaker one.
 *
 * ── What it checks, per readiness ──────────────────────────────────────────
 *   - `SCHEDULED` — the composition root must both **require** the module and **call
 *     `start()`** on it. Requiring without starting is the failure that looks most like
 *     success in a diff.
 *   - `LEADER_ONLY` — three things, in order. The module must be **reachable** from
 *     production code (§19.3 admits one writer per shard, so these start on leadership
 *     acquisition rather than at boot, but a worker no production module names is not
 *     deferred, it is absent); the leadership lifecycle must declare a **composer** for it;
 *     and that composer must not be declared **unable to build it**. References are
 *     *resolved*, not substring-matched, because a sibling's `require("./x.worker")` carries
 *     no `workers/` segment and the old check missed it.
 *   - `DEFERRED` — must carry `blockedBy` (the registry asserts this) and must **not** be
 *     started. A deferred worker that is running is a row nobody updated.
 *
 * Usage:
 *   node tools/gates/checkCompositionRoot.js [--json]
 * Exit code 0 when no violation remains, 1 otherwise.
 */

const fs = require("fs");
const path = require("path");

const registry = require("../../src/workers/registry");
// The leadership lifecycle. The gate reads its composer table and its declared blockers so
// that "is this worker actually startable" is answered by the module that would start it,
// rather than re-derived here — two answers to that question would eventually disagree.
const lifecycle = require("../../src/workers/leaderWorkers");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const COMPOSITION_ROOT = path.join(BACKEND_ROOT, "server.js");

/** Directories searched for a production reference. `tests/` is deliberately excluded. */
const PRODUCTION_SCOPE = Object.freeze(["src"]);

/** @structural finding kinds, in descending severity */
const FINDING = Object.freeze({
  /** Declared SCHEDULED; the composition root never requires it. */
  SCHEDULED_NOT_REQUIRED: "SCHEDULED_NOT_REQUIRED",
  /** Declared SCHEDULED and required, but `start()` is never called. */
  SCHEDULED_NOT_STARTED: "SCHEDULED_NOT_STARTED",
  /** Declared LEADER_ONLY; no production module references it at all. */
  LEADER_ONLY_UNREACHABLE: "LEADER_ONLY_UNREACHABLE",
  /**
   * Declared LEADER_ONLY and reachable, but the leadership lifecycle has no composer for it
   * — so leadership acquisition would start every other `LEADER_ONLY` worker and silently
   * skip this one.
   */
  LEADER_ONLY_NO_COMPOSER: "LEADER_ONLY_NO_COMPOSER",
  /**
   * Declared LEADER_ONLY and reachable, and the lifecycle declares that it **cannot** be
   * composed — a collaborator in its dependency contract has no production producer.
   *
   * This is the finding the first version of this gate could not express. It reported
   * `LEADER_ONLY_UNREACHABLE` for all four workers, which reads as "nobody wired them" and
   * is fixed by a commit. For two of them that is true. For the other two the blocker is a
   * dependency — a routing engine nobody has selected (B1), and sixteen timer handlers
   * nobody has implemented — and no amount of wiring closes it. Reporting both as the same
   * finding invited exactly the wrong fix: require the module, satisfy the gate, and start a
   * worker that runs and decides wrongly.
   */
  LEADER_ONLY_NOT_COMPOSABLE: "LEADER_ONLY_NOT_COMPOSABLE",
  /** Declared DEFERRED, yet the composition root starts it. */
  DEFERRED_BUT_STARTED: "DEFERRED_BUT_STARTED",
});

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function walk(directory, collected) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, collected);
    else if (entry.isFile() && entry.name.endsWith(".js")) collected.push(full);
  }
  return collected;
}

/**
 * The local binding a file gives a module, if it requires it.
 *
 * Matches `const x = require("...moduleTail")`, which is the only form the composition root
 * uses. A file that reached the module some other way would not be found, and that is
 * acceptable: this gate's job is to catch absence, and an exotic require is a finding of a
 * different kind.
 *
 * @param {string} source
 * @param {string} moduleTail e.g. `workers/coordinator.worker`
 * @returns {string|null}
 */
function bindingFor(source, moduleTail) {
  const escaped = moduleTail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*require\\(\\s*["'][^"']*${escaped}["']`);
  const match = source.match(pattern);
  return match ? match[1] : null;
}

/**
 * Does this source call `start()` on that binding?
 *
 * @param {string} source
 * @param {string} binding
 * @returns {boolean}
 */
function startsBinding(source, binding) {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*\\.\\s*start\\s*\\(`).test(source);
}

/**
 * Every module a source file requires, **resolved to an absolute path**.
 *
 * Resolution rather than substring matching, because the two disagree in both directions.
 * A sibling in `src/workers/` writes `require("./coordinator.worker")`, which contains no
 * `workers/` segment and was therefore invisible to the old check; and a comment or an
 * unrelated string mentioning the path would have satisfied it. What the gate means by
 * "references" is "requires the same file", and that is a question about resolution.
 *
 * @param {string} file
 * @param {string} source
 * @returns {string[]} absolute paths, for the requires that resolve
 */
function resolvedRequires(file, source) {
  const out = [];
  const pattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue; // a package, not a module of ours
    const base = path.resolve(path.dirname(file), specifier);
    for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
      try {
        if (fs.statSync(candidate).isFile()) {
          out.push(candidate);
          break;
        }
      } catch {
        // try the next extension
      }
    }
  }
  return out;
}

/**
 * Does the composition root, or any module under `src/`, require this worker's module?
 *
 * @param {object} worker a registry row
 * @param {string} compositionRoot the text of `server.js`
 * @param {Array<{file: string, source: string}>} productionSources
 * @param {string} root the backend root
 * @returns {boolean}
 */
function referencedBy(worker, compositionRoot, productionSources, root) {
  const target = path.join(root, "src", `${worker.module.replace(/^workers\//, "workers/")}.js`);
  const serverFile = path.join(root, "server.js");

  if (resolvedRequires(serverFile, compositionRoot).includes(target)) return true;
  return productionSources.some(({ file, source }) => resolvedRequires(file, source).includes(target));
}

/**
 * Run the gate.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ ok: boolean, violations: object[], checked: number, productionFiles: number }}
 */
function checkCompositionRoot(options) {
  const root = (options && options.root) || BACKEND_ROOT;
  const compositionRoot = readFileSafe(path.join(root, "server.js"));

  const productionFiles = [];
  for (const directory of PRODUCTION_SCOPE) walk(path.join(root, directory), productionFiles);
  const productionSources = productionFiles.map((file) => ({ file, source: readFileSafe(file) }));

  const violations = [];

  for (const worker of registry.WORKERS) {
    const tail = worker.module;
    const binding = bindingFor(compositionRoot, tail);

    if (worker.readiness === registry.READINESS.SCHEDULED) {
      if (!binding) {
        violations.push({
          kind: FINDING.SCHEDULED_NOT_REQUIRED,
          worker: worker.id,
          module: tail,
          tier: worker.tier,
          detail:
            `declared SCHEDULED but server.js never requires it. The registry's readiness column is a claim ` +
            "about the composition root; an unbacked claim is how a worker silently stops running.",
        });
        continue;
      }
      if (!startsBinding(compositionRoot, binding)) {
        violations.push({
          kind: FINDING.SCHEDULED_NOT_STARTED,
          worker: worker.id,
          module: tail,
          tier: worker.tier,
          detail:
            `declared SCHEDULED and required as \`${binding}\`, but \`${binding}.start(\` never appears. ` +
            "Requiring without starting is the failure that looks most like success in a diff.",
        });
      }
      continue;
    }

    if (worker.readiness === registry.READINESS.LEADER_ONLY) {
      // §19.3 admits one writer per shard, so these start on leadership acquisition rather
      // than at boot. That makes "started in server.js" the wrong check.
      //
      // ── Two checks, because "reachable" was never the property that mattered ──
      // The first version of this gate asked only whether some production file named the
      // module, matched as a *path substring*. That is a proxy twice over: a file can
      // require a module and never call it, and a relative require (`./coordinator.worker`,
      // which is what a sibling in `src/workers/` writes) does not contain the registry's
      // `workers/…` tail at all, so the check missed a real reference while claiming to
      // measure one. Both are fixed here — the reference is resolved rather than matched,
      // and reachability is only the first of two questions.
      //
      // The second is the one that decides whether the decision path actually runs: does the
      // leadership lifecycle have a composer for this worker, and can that composer build
      // it? A worker that is required, has a composer, and whose composer refuses is a
      // worker leadership acquisition will skip — which is indistinguishable, at runtime,
      // from the state this gate was written to catch.
      if (!referencedBy(worker, compositionRoot, productionSources, root)) {
        violations.push({
          kind: FINDING.LEADER_ONLY_UNREACHABLE,
          worker: worker.id,
          module: tail,
          tier: worker.tier,
          detail:
            `declared LEADER_ONLY but no module under src/ or server.js requires it. A worker started on ` +
            "leadership acquisition must still be reachable from the process that acquires leadership; a " +
            "worker nothing names is not deferred, it is absent. " +
            (worker.tier === 0
              ? "This one is Tier 0 — it is the decision path itself, so a cutover would take a shard live " +
                "onto a path that never executes."
              : ""),
        });
        continue;
      }

      if (typeof lifecycle.COMPOSERS[worker.id] !== "function") {
        violations.push({
          kind: FINDING.LEADER_ONLY_NO_COMPOSER,
          worker: worker.id,
          module: tail,
          tier: worker.tier,
          detail:
            "declared LEADER_ONLY and reachable, but `workers/leaderWorkers.js` declares no composer for it. " +
            "Leadership acquisition would start every other LEADER_ONLY worker and skip this one without saying so.",
        });
        continue;
      }

      const blocked = lifecycle.UNCOMPOSABLE[worker.id];
      if (blocked) {
        violations.push({
          kind: FINDING.LEADER_ONLY_NOT_COMPOSABLE,
          worker: worker.id,
          module: tail,
          tier: worker.tier,
          refusal: blocked.refusal,
          requires: blocked.requires,
          owner: blocked.owner,
          external: blocked.external === true,
          detail:
            `declared LEADER_ONLY and reachable, but it CANNOT BE COMPOSED: ${blocked.blockedBy} ` +
            `[requires: ${(blocked.requires || []).join(", ")}] [owner: ${blocked.owner}]` +
            (blocked.external === true
              ? " — this blocker is EXTERNAL to this repository and no commit here closes it."
              : " — this blocker is in this repository."),
        });
      }
      continue;
    }

    // DEFERRED.
    if (binding && startsBinding(compositionRoot, binding)) {
      violations.push({
        kind: FINDING.DEFERRED_BUT_STARTED,
        worker: worker.id,
        module: tail,
        tier: worker.tier,
        detail: `declared DEFERRED (blockedBy: ${worker.blockedBy || "—"}) yet the composition root starts it`,
      });
    }
  }

  const order = Object.values(FINDING);
  violations.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.worker < b.worker ? -1 : 1));

  return {
    ok: violations.length === 0,
    violations,
    checked: registry.WORKERS.length,
    productionFiles: productionSources.length,
  };
}

/**
 * Render for a terminal.
 *
 * @param {ReturnType<typeof checkCompositionRoot>} result
 * @returns {string}
 */
function formatReport(result) {
  const header = "gate: composition-root (execution plan, Phase 15 — workers move to production scheduling)";
  if (result.ok) {
    return (
      `${header}\n  PASS — ${result.checked} registered worker(s); every SCHEDULED worker is started by the ` +
      `composition root and every LEADER_ONLY worker is reachable from it.`
    );
  }
  const lines = result.violations.map(
    (violation) => `    ${violation.worker} (tier ${violation.tier}, ${violation.module})\n        [${violation.kind}] ${violation.detail}`,
  );
  return (
    `${header}\n  FAIL — ${result.violations.length} violation(s) across ${result.checked} registered worker(s):\n` +
    lines.join("\n")
  );
}

module.exports = { FINDING, bindingFor, startsBinding, checkCompositionRoot, formatReport };

if (require.main === module) {
  const result = checkCompositionRoot();
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${formatReport(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
