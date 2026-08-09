"use strict";

/**
 * Engine lane — Phase 12: the failure catalogues (§18.1–§18.4).
 *
 * The catalogue's value is completeness, so the tests that matter most are the ones that
 * check the rows against the frozen specification rather than against the module's own
 * declaration. §18.2's and §18.3's tables are parsed out of the document and compared row
 * by row: a row silently dropped during a refactor produces no other test failure anywhere,
 * because a missing row simply never fires.
 */

const fs = require("fs");
const path = require("path");

const catalogue = require("../../src/engine/failure/catalogue");
const agentFailures = require("../../src/engine/failure/agentFailures");
const infraFailures = require("../../src/engine/failure/infraFailures");
const modeRegister = require("../../src/engine/degraded/modeRegister");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SPEC = fs.readFileSync(path.join(REPO_ROOT, "NEXT_GENERATION_ASSIGNMENT_ENGINE.md"), "utf8");

/**
 * Pull the row ids out of one of §18's two tables.
 *
 * @param {string} heading
 * @param {string} endHeading
 * @returns {string[]}
 */
function rowIds(heading, endHeading) {
  const start = SPEC.indexOf(heading);
  const end = SPEC.indexOf(endHeading, start);
  const table = SPEC.slice(start, end);
  return [...table.matchAll(/^\| (A\d+|B\d+) \|/gm)].map((match) => match[1]);
}

describe("§18.2 — the agent failure catalogue", () => {
  const specIds = rowIds("### 18.2 Agent-level failure catalogue", "### 18.3");

  test("the specification tabulates twenty rows and the catalogue carries the same twenty", () => {
    expect(specIds).toHaveLength(20);
    expect([...specIds].sort()).toEqual([...agentFailures.AGENT_FAILURE_IDS].sort());
  });

  test("the catalogue preserves §18.2's own row order, including A20 between A17 and A18", () => {
    // Not cosmetic: the out-of-order placement is where the specification puts it, and a
    // catalogue that silently re-sorted would be reporting a table that does not exist.
    expect(agentFailures.AGENT_FAILURE_IDS).toEqual(specIds);
  });

  test("principle 1 — every row names a detector", () => {
    expect(catalogue.assertEveryFailureHasADetector()).toEqual({ ok: true, problems: [] });
  });

  test("principle 1 — every agent row's detection latency is a named class or a register parameter", () => {
    expect(catalogue.assertEveryLatencyIsBounded()).toEqual({ ok: true, problems: [] });

    // And every parameter it names resolves, so a "bound" is not a name nobody can look up.
    const { entries } = require("../../src/engine/config/service").loadRegister();
    for (const row of agentFailures.AGENT_FAILURES) {
      if (!row.latencyParameter) continue;
      expect({ id: row.id, registered: entries.has(row.latencyParameter) }).toEqual({ id: row.id, registered: true });
    }
  });

  test("principle 2 — every row defines an automatic response and an escalation", () => {
    expect(catalogue.assertEveryFailureHasAResponse()).toEqual({ ok: true, problems: [] });
  });

  test("principle 3 — a custody-aware row splits its response or names where the split lives", () => {
    expect(catalogue.assertCustodyAwareRowsSplitTheirResponse()).toEqual({ ok: true, problems: [] });

    // A1 states both halves inline, which is the ordinary case.
    expect(agentFailures.responseFor("A1", agentFailures.CUSTODY_PHASE.PRE_CUSTODY).response).toMatch(/reassign after connectivity.grace/);
    expect(agentFailures.responseFor("A1", agentFailures.CUSTODY_PHASE.POST_CUSTODY).response).toMatch(/monitor for reconnect/);

    // A2 delegates to §4.7, and says so. The delegation is the specification's own
    // wording, and it is the reason there is exactly one implementation of §4.7's three
    // lawful outcomes rather than two.
    expect(agentFailures.agentFailure("A2").custodyResolvedBy).toMatch(/§4\.7/);
  });

  test("principle 5 — every row has a counted, alertable escalation", () => {
    for (const id of agentFailures.AGENT_FAILURE_IDS) {
      const alerting = catalogue.alertingFor(id);
      expect({ id, escalation: Boolean(alerting.escalation), counted: alerting.counted }).toEqual({ id, escalation: true, counted: true });
    }
  });

  test("the rows that classify a stranding are the ones whose escalation depends on it", () => {
    expect(catalogue.strandingClassifyingRows().map((row) => row.id).sort()).toEqual(["A1", "A10", "A17", "A2"].sort());
  });

  test("A10 opens the §18.6 chain when only BLOCKING_CRITICAL locations are reachable", () => {
    expect(agentFailures.agentFailure("A10").externalEscalationWhenOnlyBlockingCriticalReachable).toBe(true);
    expect(agentFailures.agentFailure("A10").escalationDetail).toMatch(/§18\.6/);
  });

  test("A4 requires human clearance and A16 blocks the agent's return to the pool", () => {
    expect(agentFailures.agentFailure("A4").requiresHumanClearance).toBe(true);
    expect(agentFailures.agentFailure("A16").blocksPoolReturn).toBe(true);
  });

  test("asking a custody-aware row for a phase it does not define returns null rather than the other half", () => {
    // A17 is post-custody by definition — an agent immobilised *with custody*. Answering a
    // pre-custody question with the post-custody response, or vice versa, is the mistake
    // §2.5 exists to prevent, so the answer is null and the caller must notice.
    expect(agentFailures.responseFor("A17", agentFailures.CUSTODY_PHASE.PRE_CUSTODY).response).toBeNull();
    expect(agentFailures.responseFor("A17", agentFailures.CUSTODY_PHASE.POST_CUSTODY).response).toMatch(/TRANSFER or RECOVERY Leg/);
  });
});

describe("§18.2 A3 — the bounded dead-zone lease extension", () => {
  const CAP = 300;
  const base = {
    zoneId: "ZONE-UNDERPASS",
    mobilityProfile: "GROUND_WHEELED",
    capSeconds: CAP,
    leaseExpiryMs: 1000000,
  };

  test("a p95 within the cap extends by the measured value", () => {
    const outcome = agentFailures.deadZoneExtension({
      ...base,
      zoneStatistic: { statistic: "P95", seconds: 120, mobilityProfile: "GROUND_WHEELED", sampleCount: 400 },
    });

    expect(outcome.extended).toBe(true);
    expect(outcome.extensionSeconds).toBe(120);
    expect(outcome.cappedAtLimit).toBe(false);
    expect(outcome.alert).toBeNull();
    expect(outcome.newLeaseExpiryMs).toBe(1000000 + 120000);
    expect(outcome.supervisionSuppressed).toBe(true);
    expect(outcome.supervisionRestoredBy).toBe("CORROBORATED_EXIT");
  });

  test("a mean is refused by name — §18.2 A3 says \"never by a mean or a nominal figure\"", () => {
    for (const statistic of ["MEAN", "NOMINAL"]) {
      const outcome = agentFailures.deadZoneExtension({ ...base, zoneStatistic: { statistic, seconds: 120, mobilityProfile: "GROUND_WHEELED" } });
      expect({ statistic, extended: outcome.extended, reason: outcome.reason }).toEqual({
        statistic,
        extended: false,
        reason: agentFailures.EXTENSION_REFUSAL.WRONG_STATISTIC,
      });
      expect(outcome.supervisionSuppressed).toBe(false);
    }
  });

  test("the extension is capped, and reaching the cap alerts on every occurrence", () => {
    const outcome = agentFailures.deadZoneExtension({
      ...base,
      zoneStatistic: { statistic: "P95", seconds: 900, mobilityProfile: "GROUND_WHEELED" },
    });

    expect(outcome.extensionSeconds).toBe(CAP);
    expect(outcome.cappedAtLimit).toBe(true);
    expect(outcome.alert.code).toBe("DEADZONE_EXTENSION_AT_CAP");
    expect(outcome.alert.detail).toMatch(/mismapped, or the agent is failing inside it/);
  });

  test("a statistic measured for a different mobility profile is refused", () => {
    const outcome = agentFailures.deadZoneExtension({
      ...base,
      zoneStatistic: { statistic: "P95", seconds: 120, mobilityProfile: "AERIAL" },
    });
    expect(outcome.reason).toBe(agentFailures.EXTENSION_REFUSAL.NO_MOBILITY_PROFILE_MATCH);
  });

  test("without a resolvable cap the extension is refused, not defaulted", () => {
    // An uncapped extension is unbounded immunity from supervision during the window when
    // the agent is least observable, which is what §18.2 A3 bounds.
    const outcome = agentFailures.deadZoneExtension({
      ...base,
      capSeconds: null,
      zoneStatistic: { statistic: "P95", seconds: 120, mobilityProfile: "GROUND_WHEELED" },
    });
    expect(outcome.reason).toBe(agentFailures.EXTENSION_REFUSAL.NO_CAP_CONFIGURED);
    expect(outcome.supervisionSuppressed).toBe(false);
  });

  test("with no measured statistic at all, supervision simply continues", () => {
    const outcome = agentFailures.deadZoneExtension({ ...base, zoneStatistic: null });
    expect(outcome.reason).toBe(agentFailures.EXTENSION_REFUSAL.NO_ZONE_STATISTIC);
    expect(outcome.extensionSeconds).toBe(0);
  });

  test("supervision is restored only on a corroborated exit, never on the extension elapsing", () => {
    const corroborated = agentFailures.supervisionRestoration({ acceptedPositionFixOutsideZone: true });
    expect(corroborated).toEqual({
      restored: true,
      outcome: "CORROBORATED_EXIT",
      reason: expect.stringMatching(/accepted position fix outside the zone/),
      escalate: false,
    });

    // The elapsing of the extension is a *failure to corroborate*, which is a different and
    // more serious event than a return to normal.
    const elapsed = agentFailures.supervisionRestoration({ extensionElapsed: true });
    expect(elapsed.restored).toBe(false);
    expect(elapsed.outcome).toBe("UNCORROBORATED_EXPIRY");
    expect(elapsed.escalate).toBe(true);

    expect(agentFailures.supervisionRestoration({}).outcome).toBe("STILL_IN_WINDOW");
  });
});

describe("§18.3 — the infrastructure failure catalogue", () => {
  const specIds = rowIds("### 18.3 Infrastructure failure catalogue", "B16 and B20 deserve note");

  test("the specification tabulates twenty rows and the catalogue carries the same twenty, in order", () => {
    expect(specIds).toHaveLength(20);
    expect(infraFailures.INFRA_FAILURE_IDS).toEqual(specIds);
  });

  test("every row names a detector, a response, and an envelope reduction", () => {
    for (const row of infraFailures.INFRA_FAILURES) {
      expect({ id: row.id, detection: Boolean(row.detection), response: Boolean(row.response), envelope: Boolean(row.envelopeReduction) }).toEqual({
        id: row.id,
        detection: true,
        response: true,
        envelope: true,
      });
    }
  });

  test("the four rows that name a degraded mode name one of §18.5's six", () => {
    const withMode = infraFailures.INFRA_FAILURES.filter((row) => row.entersMode !== null);
    expect(withMode.map((row) => `${row.id}→${row.entersMode}`).sort()).toEqual(
      ["B1→CUSTODIAL_OPERATION", "B19→SHED_LOAD", "B3→COLD_INDEX", "B4→UNSUPERVISED_COMMITMENT", "B5→DEGRADED_ROUTING", "B6→DEGRADED_ROUTING"].sort(),
    );
    for (const row of withMode) {
      expect({ id: row.id, known: modeRegister.isMode(row.entersMode) }).toEqual({ id: row.id, known: true });
    }
  });

  test("§18.4 — no row in the table fails customer work", () => {
    expect(infraFailures.assertNoRowFailsCustomerWork()).toEqual({ ok: true, problems: [] });
  });

  test("B6's uniform treatment is a declared property, not a comment", () => {
    // "if any candidate's route is unavailable, *all* candidates in that decision use the
    // degraded estimator" — the defence against the baseline's partial-failure bias.
    expect(infraFailures.infraFailure("B6").uniformTreatment).toBe(true);
    expect(modeRegister.MODES.DEGRADED_ROUTING.envelope.uniformDegradedEstimation).toBe(true);
  });

  test("B16 — Tier B sheds first, Tier A is retained longest, and neither blocks a decision", () => {
    const priority = infraFailures.bufferPriority({ spillRemaining: 0 });
    expect(priority.order).toEqual(["TIER_A", "TIER_B"]);
    expect(priority.shedFirst).toBe("TIER_B");
    expect(priority.retainLongest).toBe("TIER_A");
    expect(priority.blocksDecision).toBe(false);
    expect(priority.spillExhausted).toBe(true);
    // "a decision whose Tier A record cannot be written is itself recorded as unlogged"
    expect(priority.unloggedDecisionIsRecorded).toBe(true);
  });

  test("B20 — a poison mission is quarantined after n failures and the round continues without it", () => {
    const below = infraFailures.quarantineDecision({ missionId: "MSN-9", crashCount: 2, threshold: 3 });
    expect(below.quarantine).toBe(false);
    expect(below.alert.raised).toBe(false);
    expect(below.taskOutcome).toBe("UNCHANGED");

    const at = infraFailures.quarantineDecision({ missionId: "MSN-9", crashCount: 3, threshold: 3 });
    expect(at.quarantine).toBe(true);
    // "One task blocked, fleet unaffected; always alert."
    expect(at.continueRoundWithoutIt).toBe(true);
    expect(at.alert.raised).toBe(true);
    // Blocked and escalated, never failed (§18.4).
    expect(at.taskOutcome).toBe("BLOCKED_PENDING_INVESTIGATION");
  });

  test("B20's threshold is a registered parameter, not a bare constant", () => {
    const { entries } = require("../../src/engine/config/service").loadRegister();
    expect(entries.has("failure.poison_quarantine_threshold")).toBe(true);
    expect(infraFailures.DEFAULT_QUARANTINE_THRESHOLD).toBe(entries.get("failure.poison_quarantine_threshold").default);
  });
});

describe("the catalogue's join with the mode register", () => {
  test("is total in both directions", () => {
    expect(catalogue.assertModeJoinIsTotal()).toEqual({ ok: true, problems: [] });
  });

  test("every mode is reachable from a catalogue row, except Restricted Operation", () => {
    // §7.4's guard trips on a measured indeterminacy fraction rather than on a catalogue
    // row, and that exception is declared rather than left as a gap.
    for (const mode of modeRegister.MODE_NAMES) {
      const trigger = modeRegister.modeOf(mode).entryTrigger;
      if (mode === modeRegister.MODE.RESTRICTED_OPERATION) {
        expect(trigger).toBe("F7.4");
        continue;
      }
      expect({ mode, row: Boolean(catalogue.lookup(trigger)) }).toEqual({ mode, row: true });
    }
  });

  test("every §18.1 principle assertion passes over the whole catalogue", () => {
    expect(catalogue.assertCatalogue()).toEqual({ ok: true, problems: [] });
  });

  test("forty rows across both halves, indexed by id", () => {
    expect(catalogue.CATALOGUE_IDS).toHaveLength(40);
    expect(catalogue.lookup("A1").failureClass).toBe(catalogue.FAILURE_CLASS.AGENT);
    expect(catalogue.lookup("B1").failureClass).toBe(catalogue.FAILURE_CLASS.INFRASTRUCTURE);
    expect(catalogue.lookup("C1")).toBeNull();
  });
});
