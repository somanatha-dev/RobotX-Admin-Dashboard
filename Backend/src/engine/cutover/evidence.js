"use strict";

/**
 * What counts as evidence for a §24 release gate — **Tier 0 by consequence**.
 *
 * ── The defect this module exists to close ─────────────────────────────────
 * `cutover/gates.js` made each gate an object rather than a line in a document, and its
 * header states the reason:
 *
 * > A release gate recorded in prose is a gate that is satisfied by someone writing that
 * > it is satisfied.
 *
 * That argument is correct and it was applied one level too high. The *gate* stopped being
 * prose; the *evidence* did not. `gates.evaluate()` read `record.pass === true` and asked
 * nothing else, and no module in this repository ever produced a record. The only
 * producers were test fixtures. So the whole table reduced to whatever object the caller
 * of `stage.authoriseEnable()` happened to hold, and this authorised a real cutover:
 *
 *     for (const gate of RELEASE_GATES) fake[gate.id] = { pass: true, detail: "looks fine to me" };
 *
 * Twenty-three blocking gates, twenty-three hand-typed booleans, one authorised binding
 * of `cutover.engine_enabled = true`. The gate table was satisfied by someone writing that
 * it was satisfied — exactly the failure its own header names.
 *
 * This module is the missing half. A gate is discharged by a **record of something having
 * happened**, and this is where the difference between that and an assertion is decided.
 *
 * ── Admissibility, per evidence kind ───────────────────────────────────────
 * `gates.js` already classifies every gate by how it can be discharged. That classification
 * is load-bearing here, because the four kinds admit genuinely different records:
 *
 *   - `BUILD` / `SUITE` — dischargeable by this repository, and therefore the only kinds a
 *     build may close. A record must be a **run record**: the command that ran, its exit
 *     code, when it started and finished, and the source state it ran against. `pass` is
 *     not read from the record — it is *derived* from `exitCode === 0`, so a producer
 *     cannot report success for a command that failed. The declared command must match the
 *     gate's own `command`, so evidence from `npm run gate:tiers` cannot discharge
 *     `scale_targets`.
 *
 *   - `PRODUCTION` — **not closable by a build**, by construction (`gates.js`). A record
 *     must carry an observation window with a real duration, the system that observed it,
 *     and an owner. A run record is *refused* for these gates rather than accepted, because
 *     a build that could emit one would be a build closing a production gate — which is the
 *     one thing the evidence taxonomy exists to prevent.
 *
 *   - `ORGANISATIONAL` — requires a named human to have done something (§22.4's calibration
 *     owner; a rehearsed rollback). A record must name a recorder and a **distinct**
 *     approver, for the same reason `stage.authoriseEnable` requires two people: a person
 *     who can attest to their own work has not been reviewed.
 *
 * ── Binding to the thing that was measured ─────────────────────────────────
 * A run record names the source state it ran against (`build.sourceDigest`). A gate run on
 * one tree and read against another is evidence about a program nobody is shipping, and
 * "restore the file after the gate passed" is the cheapest attack on a build gate there is.
 * `admit()` refuses a run record whose digest differs from the tree being assessed.
 *
 * Every record also expires. `maxAgeMs` is supplied by the caller rather than defaulted
 * here, because how stale a soak may be and how stale a tier scan may be are different
 * questions; what is *not* negotiable is that both have an answer.
 *
 * ── Inadmissible is RED, not a fourth status ───────────────────────────────
 * `gates.js` deliberately has three statuses. An inadmissible record does not need a
 * fourth: `RED` is defined there as "evidence was supplied and it does **not** satisfy the
 * gate", and a record nobody can rely on is precisely that. It is kept apart from
 * `NOT_EVALUATED` — which means nobody ran it — because an incident review must be able to
 * tell a forged record from a missing one. `admit()` returns the reason either way, so the
 * refusal names what was wrong rather than only that something was.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Every instant is supplied.
 */

/**
 * The evidence kinds this module knows how to admit.
 *
 * Declared here rather than imported from `gates.js` because `gates.js` requires *this*
 * module, and a cycle between the table and the rule that reads it would make load order
 * decide behaviour. `gates.js` asserts at load that its own `EVIDENCE` matches this set
 * exactly, so the duplication cannot drift into a kind nobody adjudicates.
 *
 * @structural the four §24 evidence kinds; `gates.assertGates()` pins them to this set
 */
const KINDS = Object.freeze({
  BUILD: "BUILD",
  SUITE: "SUITE",
  PRODUCTION: "PRODUCTION",
  ORGANISATIONAL: "ORGANISATIONAL",
});

/** @structural why a record was refused; a caller branches on these rather than on prose */
const INADMISSIBLE = Object.freeze({
  NOT_AN_OBJECT: "NOT_AN_OBJECT",
  GATE_ID_MISMATCH: "GATE_ID_MISMATCH",
  SELF_ASSERTED: "SELF_ASSERTED",
  RUN_RECORD_REQUIRED: "RUN_RECORD_REQUIRED",
  COMMAND_MISMATCH: "COMMAND_MISMATCH",
  EXIT_CODE_MISSING: "EXIT_CODE_MISSING",
  PASS_CONTRADICTS_EXIT_CODE: "PASS_CONTRADICTS_EXIT_CODE",
  SOURCE_DIGEST_MISMATCH: "SOURCE_DIGEST_MISMATCH",
  SOURCE_DIGEST_REQUIRED: "SOURCE_DIGEST_REQUIRED",
  BUILD_CANNOT_CLOSE: "BUILD_CANNOT_CLOSE",
  OBSERVATION_WINDOW_REQUIRED: "OBSERVATION_WINDOW_REQUIRED",
  OBSERVATION_WINDOW_TOO_SHORT: "OBSERVATION_WINDOW_TOO_SHORT",
  OWNER_REQUIRED: "OWNER_REQUIRED",
  APPROVER_REQUIRED: "APPROVER_REQUIRED",
  APPROVER_NOT_DISTINCT: "APPROVER_NOT_DISTINCT",
  STALE: "STALE",
  PRODUCED_IN_THE_FUTURE: "PRODUCED_IN_THE_FUTURE",
  // ── D-7: a gate discharged by a rehearsal ────────────────────────────────
  REHEARSAL_RECORD_REQUIRED: "REHEARSAL_RECORD_REQUIRED",
  REHEARSAL_NOT_IN_A_REHEARSAL_ENVIRONMENT: "REHEARSAL_NOT_IN_A_REHEARSAL_ENVIRONMENT",
  REHEARSAL_INCOMPLETE: "REHEARSAL_INCOMPLETE",
  REHEARSAL_NOT_AUTOMATIC: "REHEARSAL_NOT_AUTOMATIC",
  REHEARSAL_CONFIGURATION_UNIDENTIFIED: "REHEARSAL_CONFIGURATION_UNIDENTIFIED",
});

/**
 * The steps a rollback rehearsal must have performed, from `docs/runbooks/rollback.md` §5.
 *
 * Named individually rather than counted, because §22.5's argument is about *which* step is
 * skipped and not how many were: "Step 4 is the one that will be skipped and it is the one
 * that matters." A record that reports five of six steps must say which five, and a
 * contract that only counted them could not tell the difference.
 *
 * @structural the rehearsal's step set, from the runbook that defines it
 */
const REHEARSAL_STEPS = Object.freeze([
  /** Take a staging shard live through the full §3 of `cutover.md`, including pre-declaration. */
  "cutover",
  /** Breach a guardrail deliberately so the **controller** rolls back — never by calling the API. */
  "automatic_rollback",
  /** Confirm the shard reports no decision path and new work is refused with a reason. */
  "no_decision_path_confirmed",
  /** Rollback B end to end: identify the artefact, deploy it, confirm the previous path serves. */
  "artefact_rollback",
  /** Re-cutover. */
  "recutover",
  /** Record the date, the operators, the wall-clock time of each step, and the surprises. */
  "recorded",
]);

/**
 * The gates whose whole content is a duration, and the registered parameter that states it.
 *
 * The *number* is deliberately not here. §22.1 admits no behavioural constant outside the
 * parameter register, and a two-week shadow window written twice — once in Appendix A and
 * once in this file — is two windows that will eventually disagree. What is structural is
 * *which parameter governs which gate*, and that is what this table holds.
 *
 * A gate absent from this table has no duration requirement beyond "the window is real".
 * A gate present in it whose duration the caller did not supply is **refused**, not
 * defaulted: a missing bound must never read as a satisfied one.
 *
 * @structural the gate → parameter binding §21.6/§24.6 fix; the values live in the register
 */
const MIN_OBSERVATION_PARAMETER = Object.freeze({
  /** §21.6 / execution plan Phase 15: "run shadow mode against live traffic for ≥ 2 weeks". */
  shadow_agreement: "cutover.shadow_agreement_window",
  /** §24.6: "soak tests over days"; `release.soak_duration` names the figure. */
  soak: "release.soak_duration",
});

/** @structural the register's unit for each of those parameters, so a caller converts once */
const MIN_OBSERVATION_UNIT = Object.freeze({
  shadow_agreement: "days",
  soak: "hours",
});

/** @structural milliseconds per hour — a unit conversion, not a tunable */
const MS_PER_HOUR = 3600000;

/** @structural hours per day — a unit conversion, not a tunable */
const HOURS_PER_DAY = 24;

/**
 * Resolve the duration bounds from a configuration values map.
 *
 * Injected rather than imported: no `src/engine/**` module reads the Config Service
 * directly, and this one must not become the first. The caller — a release tool, the health
 * controller, the cutover worker — holds the resolved configuration already.
 *
 * A parameter that does not resolve is **omitted** rather than defaulted, which makes
 * `admit()` refuse the gate. That is the correct direction: an unbounded soak is not a
 * soak, and inventing a bound here would be inventing the gate.
 *
 * @param {{ get: (name: string) => any }} values
 * @returns {object} `{ [gateId]: milliseconds }`
 */
function resolveMinObservationMs(values) {
  const perUnit = { hours: MS_PER_HOUR, days: HOURS_PER_DAY * MS_PER_HOUR };
  const resolved = {};
  if (!values || typeof values.get !== "function") return resolved;
  for (const [gateId, parameter] of Object.entries(MIN_OBSERVATION_PARAMETER)) {
    const value = values.get(parameter);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      resolved[gateId] = value * perUnit[MIN_OBSERVATION_UNIT[gateId]];
    }
  }
  return resolved;
}

function refuse(code, detail) {
  return { admissible: false, pass: false, code, detail };
}

function accept(pass, detail) {
  return { admissible: true, pass, code: null, detail: detail || null };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalise a command for comparison. Whitespace and surrounding quotes vary between a
 * shell, a CI runner and a runbook; the identity of the command does not.
 *
 * @param {string} command
 * @returns {string}
 */
function normaliseCommand(command) {
  return String(command || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Is this record admissible for this gate, and does it discharge it?
 *
 * @param {object} gate a row from `gates.RELEASE_GATES`
 * @param {object} record the filed evidence
 * @param {object} context `{ nowMs, maxAgeMs, sourceDigest }`
 * @returns {{ admissible: boolean, pass: boolean, code: string|null, detail: string|null }}
 */
function admit(gate, record, context) {
  const at = context || {};
  if (!record || typeof record !== "object") {
    return refuse(INADMISSIBLE.NOT_AN_OBJECT, "evidence must be a record, not a value");
  }

  // A record that does not name its gate cannot be checked against that gate's command or
  // its evidence kind, and a mis-filed record is evidence that was never counted.
  if (!nonEmpty(record.gateId) || record.gateId !== gate.id) {
    return refuse(
      INADMISSIBLE.GATE_ID_MISMATCH,
      `record names gate ${record.gateId || "(none)"} but was filed against ${gate.id}`,
    );
  }

  if (typeof record.producedAtMs !== "number" || !Number.isFinite(record.producedAtMs)) {
    return refuse(
      INADMISSIBLE.SELF_ASSERTED,
      "a record carries the instant it was produced; without one it cannot be aged, ordered or disputed",
    );
  }
  if (typeof at.nowMs === "number" && record.producedAtMs > at.nowMs) {
    return refuse(
      INADMISSIBLE.PRODUCED_IN_THE_FUTURE,
      "a record stamped after the moment it is read has a clock nobody should trust",
    );
  }
  if (
    typeof at.nowMs === "number" &&
    typeof at.maxAgeMs === "number" &&
    at.nowMs - record.producedAtMs > at.maxAgeMs
  ) {
    return refuse(
      INADMISSIBLE.STALE,
      `record is ${Math.round((at.nowMs - record.producedAtMs) / 1000)}s old; the gate admits ` +
        `${Math.round(at.maxAgeMs / 1000)}s. Stale evidence is evidence about a system that has since changed.`,
    );
  }
  if (!nonEmpty(record.producer)) {
    return refuse(
      INADMISSIBLE.SELF_ASSERTED,
      "a record names what produced it. An anonymous record cannot be reproduced, which is the " +
        "property §24.7 asks the safety evidence to have.",
    );
  }

  const kind = gate.evidence;

  if (kind === KINDS.BUILD || kind === KINDS.SUITE) {
    const run = record.run;
    if (!run || typeof run !== "object") {
      return refuse(
        INADMISSIBLE.RUN_RECORD_REQUIRED,
        `${gate.id} is discharged by running \`${gate.command}\`. A record with no run is an assertion ` +
          "that it would have passed.",
      );
    }
    if (normaliseCommand(run.command) !== normaliseCommand(gate.command)) {
      return refuse(
        INADMISSIBLE.COMMAND_MISMATCH,
        `record reports \`${run.command}\` but ${gate.id} is discharged by \`${gate.command}\``,
      );
    }
    if (typeof run.exitCode !== "number" || !Number.isInteger(run.exitCode)) {
      return refuse(
        INADMISSIBLE.EXIT_CODE_MISSING,
        "a run record carries the process exit code. It is the only part of a run that cannot be phrased.",
      );
    }
    // `pass` is derived, never read. A producer that reported success for a failing command
    // would otherwise be believed, and that is the whole attack.
    const derived = run.exitCode === 0;
    if (record.pass !== undefined && record.pass !== derived) {
      return refuse(
        INADMISSIBLE.PASS_CONTRADICTS_EXIT_CODE,
        `record claims pass=${record.pass} for exit code ${run.exitCode}. The exit code decides.`,
      );
    }
    {
      /**
       * The binding is **mandatory**, not conditional on the caller having supplied a tree.
       *
       * The first version read `if (nonEmpty(at.sourceDigest)) { … }`, which meant a caller
       * who simply omitted `sourceDigest` from the context got no binding at all and stale or
       * foreign run records were admitted. `stage.authoriseEnable()` passes the field straight
       * through from its request, so that omission was reachable at the one call site whose
       * whole job is to be the authority — a fail-open in the middle of a fail-closed design.
       *
       * A run record is a claim about a particular tree. Judging one without knowing which
       * tree is being judged is not a weaker check; it is no check.
       */
      const build = record.build || {};
      if (!nonEmpty(at.sourceDigest)) {
        return refuse(
          INADMISSIBLE.SOURCE_DIGEST_REQUIRED,
          "no source digest was supplied to evaluate against. A run record can only be judged against the " +
            "tree it is being read for; without one this would admit evidence from any build.",
        );
      }
      if (!nonEmpty(build.sourceDigest)) {
        return refuse(
          INADMISSIBLE.SOURCE_DIGEST_MISMATCH,
          "a run record names the source state it ran against; without one it cannot be bound to this tree",
        );
      }
      if (build.sourceDigest !== at.sourceDigest) {
        return refuse(
          INADMISSIBLE.SOURCE_DIGEST_MISMATCH,
          `record ran against source ${String(build.sourceDigest).slice(0, 12)} and this tree is ` +
            `${String(at.sourceDigest).slice(0, 12)}. A gate that passed on a different tree is evidence ` +
            "about a program nobody is shipping.",
        );
      }
    }
    return accept(derived, `exit ${run.exitCode} from \`${run.command}\``);
  }

  // PRODUCTION and ORGANISATIONAL. Neither is closable by a build, so a run record here is
  // refused rather than ignored: emitting one is how a build would close a gate it may not.
  if (record.run) {
    return refuse(
      INADMISSIBLE.BUILD_CANNOT_CLOSE,
      `${gate.id} is ${kind} evidence and carries a run record. §24 splits the kinds precisely so a ` +
        "build cannot discharge a gate that requires the fleet to have operated, or a person to have acted.",
    );
  }
  if (!nonEmpty(record.owner)) {
    return refuse(
      INADMISSIBLE.OWNER_REQUIRED,
      `${gate.id} is ${kind} evidence and names no owner. §22.4 names the organisational failure mode as ` +
        '"the most likely way this design fails in practice"; an unowned record is that failure filed.',
    );
  }

  if (kind === KINDS.PRODUCTION) {
    const observation = record.observation;
    if (
      !observation ||
      typeof observation.windowStartedAtMs !== "number" ||
      typeof observation.windowEndedAtMs !== "number" ||
      !nonEmpty(observation.source)
    ) {
      return refuse(
        INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED,
        `${gate.id} is discharged by realised data over wall-clock time. A record must carry the window ` +
          "it observed and the system that observed it.",
      );
    }
    const duration = observation.windowEndedAtMs - observation.windowStartedAtMs;
    const bounds = at.minObservationMs || {};
    const required = bounds[gate.id];
    if (duration <= 0) {
      return refuse(INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT, "the observation window ends before it begins");
    }
    if (MIN_OBSERVATION_PARAMETER[gate.id] && typeof required !== "number") {
      return refuse(
        INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED,
        `${gate.id}'s minimum window is ${MIN_OBSERVATION_PARAMETER[gate.id]} and it did not resolve. An ` +
          "unbounded window is not a window; the bound is refused rather than defaulted.",
      );
    }
    if (typeof required === "number" && duration < required) {
      return refuse(
        INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT,
        `window is ${Math.round(duration / MS_PER_HOUR)}h and ${gate.id} requires ` +
          `${Math.round(required / MS_PER_HOUR)}h. The duration is the gate.`,
      );
    }
    return accept(record.pass === true, `observed over ${Math.round(duration / MS_PER_HOUR)}h by ${observation.source}`);
  }

  // ORGANISATIONAL.
  //
  // Two signatures, and — where the gate declares a `runnable` check — the check having
  // actually passed. An owner attesting that every Safety-class parameter is DERIVED while
  // `gate:calibration` exits 1 is an attestation contradicted by the artefact it is about,
  // and §22.4 predicts exactly that pressure: "the predictable outcome is not a missed
  // deadline but a loss of trust". The corroboration is not a second attestation; it is a
  // run record, adjudicated by the same rules a BUILD gate's would be.
  if (gate.runnable === true) {
    const corroboration = record.corroboratingRun;
    if (!corroboration || typeof corroboration !== "object") {
      return refuse(
        INADMISSIBLE.RUN_RECORD_REQUIRED,
        `${gate.id} declares the machine-checkable command \`${gate.command}\`. The attestation is necessary ` +
          "and not sufficient: a corroborating run of that command must accompany it.",
      );
    }
    if (normaliseCommand(corroboration.command) !== normaliseCommand(gate.command)) {
      return refuse(
        INADMISSIBLE.COMMAND_MISMATCH,
        `corroborating run reports \`${corroboration.command}\` but ${gate.id} declares \`${gate.command}\``,
      );
    }
    if (typeof corroboration.exitCode !== "number" || !Number.isInteger(corroboration.exitCode)) {
      return refuse(INADMISSIBLE.EXIT_CODE_MISSING, "a corroborating run carries the process exit code");
    }
    if (corroboration.exitCode !== 0) {
      return refuse(
        INADMISSIBLE.PASS_CONTRADICTS_EXIT_CODE,
        `\`${gate.command}\` exited ${corroboration.exitCode}. An attestation cannot outrank the check it ` +
          "is an attestation about.",
      );
    }
    // Mandatory for the same reason it is mandatory on a run record above: a corroborating
    // run is a run record, and one that cannot be bound to a tree corroborates nothing.
    const build = corroboration.build || {};
    if (!nonEmpty(at.sourceDigest)) {
      return refuse(
        INADMISSIBLE.SOURCE_DIGEST_REQUIRED,
        `no source digest was supplied to evaluate ${gate.id}'s corroborating run against`,
      );
    }
    if (build.sourceDigest !== at.sourceDigest) {
      return refuse(
        INADMISSIBLE.SOURCE_DIGEST_MISMATCH,
        `the corroborating run ran against a different tree than the one being assessed`,
      );
    }
  }

  // ── D-7 — a gate discharged by a rehearsal needs the rehearsal, not a claim of one ──
  //
  // `rollback_rehearsed` was the gate the whole circularity turned on: it is discharged by
  // rehearsing the rollback, the rehearsal requires a cutover, and the cutover requires the
  // gate. `stage.js` breaks that by admitting a REHEARSAL purpose that excludes exactly this
  // gate against a declared rehearsal environment — which makes the rehearsal *performable*.
  //
  // This is the other half, and without it the first half would be a hole rather than a fix:
  // if the rehearsal is now possible, the evidence it produces must be checkable, or the
  // exclusion would simply have moved the forgery one step along. Two signatures alone would
  // not do it — that is a claim that a rehearsal happened, which is precisely what the
  // runbook says must never discharge this gate ("Do not resolve this by filing an
  // attestation for a rehearsal that has not happened").
  //
  // So the record must carry the rehearsal itself: which environment, which configuration
  // version, when, and — step by step — what was actually done, including the one step §22.5
  // predicts will be skipped. It ages by the same `maxAgeMs` rule every other record does, so
  // a rehearsal from a year ago is not a rehearsal of the system being shipped.
  if (gate.rehearsal === true) {
    const rehearsal = record.rehearsal;
    if (!rehearsal || typeof rehearsal !== "object") {
      return refuse(
        INADMISSIBLE.REHEARSAL_RECORD_REQUIRED,
        `${gate.id} is discharged by performing the rehearsal, not by attesting to it. The record must carry ` +
          "the environment, the configuration version, the instant, and each step of " +
          "docs/runbooks/rollback.md §5.",
      );
    }

    // The environment must declare itself a rehearsal environment. A "rehearsal" performed
    // against production is a production cutover with a different label on it, and the
    // exclusion `stage.js` grants would then have been granted to the real thing.
    const environment = rehearsal.environment || {};
    if (!nonEmpty(environment.id) || environment.production !== false) {
      return refuse(
        INADMISSIBLE.REHEARSAL_NOT_IN_A_REHEARSAL_ENVIRONMENT,
        "a rehearsal names its environment and that environment declares itself non-production " +
          "(`{ id, production: false }`). An unnamed environment cannot be audited, and a production one " +
          "makes the rehearsal a cutover.",
      );
    }

    // Which configuration was rehearsed. A rollback rehearsed against one published version
    // is not evidence about another: §22.1 rule 4 makes the version the unit of what a
    // process observes, and the rollback path is configuration all the way down.
    if (!nonEmpty(rehearsal.configVersion)) {
      return refuse(
        INADMISSIBLE.REHEARSAL_CONFIGURATION_UNIDENTIFIED,
        "a rehearsal records the published configuration version it exercised (§22.1 rule 4)",
      );
    }

    // Every step, named. `steps` is a map of step → boolean; a missing step is a step that
    // was not done, which is the same finding as one reported false.
    const steps = rehearsal.steps || {};
    const missing = REHEARSAL_STEPS.filter((step) => steps[step] !== true);
    if (missing.length > 0) {
      return refuse(
        INADMISSIBLE.REHEARSAL_INCOMPLETE,
        `the rehearsal did not complete: ${missing.join(", ")}. §22.5 — "An untested kill switch is not a ` +
          'control; it is a second, less well understood code path that will be invoked for the first time ' +
          'during an incident."',
      );
    }

    // Step 2's substance, checked separately from its checkbox. The runbook is explicit that
    // what is under test is the **controller**, not the API: a rehearsal that called the
    // rollback function directly has exercised the one path that was never in doubt.
    if (rehearsal.automaticRollbackFired !== true) {
      return refuse(
        INADMISSIBLE.REHEARSAL_NOT_AUTOMATIC,
        "the rollback was not triggered by the guardrail controller. Calling the rollback function directly " +
          "tests the API; what this gate is about is whether the controller fires on a real breach.",
      );
    }
  }

  const approval = record.approval;
  if (!approval || !nonEmpty(approval.recordedBy) || !nonEmpty(approval.approvedBy)) {
    return refuse(
      INADMISSIBLE.APPROVER_REQUIRED,
      `${gate.id} requires a named human act, recorded and approved. §22.3 requires two-person approval ` +
        "for the Safety class, and this gate is part of the largest change that class admits.",
    );
  }
  if (approval.recordedBy === approval.approvedBy) {
    return refuse(
      INADMISSIBLE.APPROVER_NOT_DISTINCT,
      "the recorder and the approver are the same person. A person who can attest to their own work has " +
        "not been reviewed.",
    );
  }
  return accept(record.pass === true, `recorded by ${approval.recordedBy}, approved by ${approval.approvedBy}`);
}

module.exports = {
  KINDS,
  INADMISSIBLE,
  REHEARSAL_STEPS,
  MIN_OBSERVATION_PARAMETER,
  MIN_OBSERVATION_UNIT,
  resolveMinObservationMs,
  normaliseCommand,
  admit,
};
