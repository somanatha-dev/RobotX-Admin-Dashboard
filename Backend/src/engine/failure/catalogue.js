"use strict";

/**
 * The failure catalogue (§18.1–§18.4) — **Tier 0**, mechanism T0-11.
 *
 * `agentFailures.js` carries §18.2's twenty rows and `infraFailures.js` carries §18.3's
 * twenty. This module is the index over both, and — more importantly — the place where
 * §18.1's five principles stop being prose:
 *
 *   1. **Every failure has a detector with a bounded detection latency.**
 *      `assertEveryFailureHasADetector()` fails a row with no detection column, and
 *      `assertEveryLatencyIsBounded()` fails one whose latency is neither a named class
 *      nor a register parameter. The audit's finding that "nine baseline failure modes"
 *      had detection "No" is exactly what an unenforced principle 1 looks like after a
 *      few years.
 *   2. **Every failure has a defined automatic response and a defined escalation.**
 *      `assertEveryFailureHasAResponse()`. Undefined behaviour under failure is a design
 *      defect, not an operational surprise — so it is a build failure here.
 *   3. **Responses are custody-aware.** `assertCustodyAwareRowsSplitTheirResponse()`
 *      fails a row marked custody-aware that gives one undifferentiated response.
 *   4. **Degradation reduces the envelope, never the safety margin.** Every mode a row
 *      names must be one of §18.5's six, and the register's own rule-4 assertion covers
 *      what those modes may do — so this module checks the *join* rather than restating
 *      the rule.
 *   5. **Every automatic response is counted and alerted.** `alertingFor()` returns the
 *      escalation disposition for any row, and there is no row without one (principle 2's
 *      assertion covers it), which is what makes "counted and alerted" a property of the
 *      table rather than of each call site's diligence.
 *
 * ── The join with the mode register is checked in both directions ───────────
 * A row naming a seventh mode is a defect. A *mode* whose entry trigger names no
 * catalogue row is also a defect — it would be a shard state nothing can cause, which is
 * the same class of error seen from the other end. `assertModeJoinIsTotal()` checks both.
 * The one deliberate exception is Restricted Operation, whose trigger is §7.4's measured
 * indeterminacy fraction rather than a catalogue row, and which is named as such.
 *
 * Pure data and assertions. No clock, no store, no I/O.
 */

const agentFailures = require("./agentFailures");
const infraFailures = require("./infraFailures");
const modeRegister = require("../degraded/modeRegister");

/**
 * The two halves of §18's catalogue.
 * @structural the specification's own partition of §18.2 from §18.3
 */
const FAILURE_CLASS = Object.freeze({
  AGENT: "AGENT",
  INFRASTRUCTURE: "INFRASTRUCTURE",
});

/**
 * Every row, both halves, keyed by id.
 */
const CATALOGUE = Object.freeze(
  [
    ...agentFailures.AGENT_FAILURES.map((row) => ({ ...row, failureClass: FAILURE_CLASS.AGENT, section: "§18.2" })),
    ...infraFailures.INFRA_FAILURES.map((row) => ({ ...row, failureClass: FAILURE_CLASS.INFRASTRUCTURE, section: "§18.3" })),
  ].reduce((index, row) => Object.assign(index, { [row.id]: Object.freeze(row) }), Object.create(null)),
);

const CATALOGUE_IDS = Object.freeze(Object.keys(CATALOGUE));

/**
 * One row from either half.
 *
 * @param {string} id
 * @returns {object|null}
 */
function lookup(id) {
  return CATALOGUE[id] || null;
}

/**
 * Principle 5 — the escalation disposition for a row.
 *
 * @param {string} id
 * @returns {{ id: string, escalation: string|null, detail: string|null, counted: boolean }}
 */
function alertingFor(id) {
  const row = lookup(id);
  if (!row) throw new TypeError(`"${String(id)}" is not a §18.2 or §18.3 catalogue row`);
  return {
    id: row.id,
    escalation: row.escalation ?? null,
    detail: row.escalationDetail ?? row.envelopeReduction ?? null,
    // T10: every automatic response is counted. There is no row for which this is false —
    // an uncounted automatic response is a system acting invisibly.
    counted: true,
  };
}

/**
 * The rows that classify a stranding, and therefore feed `map/obstructionClass.js` and,
 * where the class is obstructing, the §18.6 chain.
 *
 * @returns {object[]}
 */
function strandingClassifyingRows() {
  return CATALOGUE_IDS.map((id) => CATALOGUE[id]).filter((row) => row.classifiesStranding === true);
}

/* ═══════════════════════════════════════════════════════════════════════════
   §18.1's principles, as assertions
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Principle 1, first half — every failure has a detector.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertEveryFailureHasADetector() {
  const problems = [];
  for (const id of CATALOGUE_IDS) {
    if (!CATALOGUE[id].detection) {
      problems.push(
        `${id} "${CATALOGUE[id].failure}" names no detector. §18.1 principle 1: "An undetected failure is ` +
          'the worst kind"; the audit lists nine baseline failure modes whose detection is "No".',
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Principle 1, second half — every *agent* failure has a bounded detection latency.
 *
 * §18.3's table has no latency column: an infrastructure failure is detected by a health
 * check or a write failure whose latency is the check's own interval, and §18.3 does not
 * bound it per row. So the bound is asserted over §18.2, which does state one for every
 * row, and the asymmetry is recorded here rather than papered over by inventing latencies
 * the specification does not give.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertEveryLatencyIsBounded() {
  const problems = [];
  const classes = Object.values(agentFailures.LATENCY_CLASS);

  for (const row of agentFailures.AGENT_FAILURES) {
    if (!classes.includes(row.latencyClass)) {
      problems.push(`${row.id} names latency class "${String(row.latencyClass)}", which is not one of §18.2's`);
      continue;
    }
    if (row.latencyClass === agentFailures.LATENCY_CLASS.BOUNDED_BY_PARAMETER && !row.latencyParameter) {
      problems.push(
        `${row.id} declares a parameter-bounded detection latency and names no parameter. A bound nobody ` +
          "can resolve is not a bound (§22.1 rule 1).",
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Principle 2 — every failure has a defined automatic response and a defined escalation.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertEveryFailureHasAResponse() {
  const problems = [];
  for (const id of CATALOGUE_IDS) {
    const row = CATALOGUE[id];
    const hasResponse =
      row.failureClass === FAILURE_CLASS.AGENT
        ? row.response && Object.keys(row.response).length > 0
        : Boolean(row.response);
    if (!hasResponse) {
      problems.push(`${id} defines no automatic response. §18.1 principle 2: undefined behaviour under failure is a design defect.`);
    }
    const hasEscalation = row.failureClass === FAILURE_CLASS.AGENT ? Boolean(row.escalation) : Boolean(row.envelopeReduction);
    if (!hasEscalation) {
      problems.push(
        `${id} defines no escalation (§18.2) or envelope reduction (§18.3). A failure with no stated ` +
          "consequence is one nobody decided the cost of.",
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Principle 3 — a custody-aware row states both sides, **or names where the branch lives**.
 *
 * The second clause exists for exactly one row. §18.2 words A2's response as "… then §4.7"
 * and its escalation as "as A1", so its custody branch is §4.7's, evaluated once in
 * `supervision/leases.assessRecovery`. Restating §4.7's three lawful outcomes in a
 * catalogue row would be a second implementation of them, and two implementations of a
 * custody decision is the drift §2.5 is least able to tolerate. What the assertion refuses
 * is a row that is *silently* undifferentiated — one that gives a single response and names
 * nowhere the split happens, which is indistinguishable from having forgotten it.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertCustodyAwareRowsSplitTheirResponse() {
  const problems = [];
  for (const row of agentFailures.AGENT_FAILURES) {
    if (row.custodyAware !== true) continue;
    if (row.custodyResolvedBy) continue;
    const phases = Object.keys(row.response);
    const undifferentiated = phases.length === 1 && phases[0] === agentFailures.CUSTODY_PHASE.EITHER;
    if (undifferentiated) {
      problems.push(
        `${row.id} is marked custody-aware but gives one undifferentiated response and names no ` +
          '`custodyResolvedBy`. §18.1 principle 3: "Before custody, software recovers. After custody, ' +
          'physical logistics recovers." Applying the pre-custody response to an agent holding goods is ' +
          "the mistake §2.5 exists to prevent.",
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The join with §18.5, in both directions.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertModeJoinIsTotal() {
  const problems = [];

  // Forward: no row may name a mode the register does not declare.
  for (const row of infraFailures.INFRA_FAILURES) {
    if (row.entersMode !== null && !modeRegister.isMode(row.entersMode)) {
      problems.push(
        `${row.id} names degraded mode "${row.entersMode}", which is not one of §18.5's six. A catalogue row ` +
          "cannot invent a seventh mode; §18.5's whole point is that the set is named and closed.",
      );
    }
  }

  // Reverse: every declared mode must be reachable, so no mode is a state nothing causes.
  for (const mode of modeRegister.MODE_NAMES) {
    const trigger = modeRegister.modeOf(mode).entryTrigger;
    if (trigger === "F7.4") {
      // Restricted Operation's trigger is §7.4's measured indeterminacy fraction, not a
      // catalogue row. Named explicitly so the exception is a decision rather than a gap.
      continue;
    }
    if (!lookup(trigger)) {
      problems.push(
        `${mode} names entry trigger "${trigger}", which is not a catalogue row. A mode nothing can cause ` +
          "is a shard state that will never be entered — the same defect as an uncaused failure, seen from " +
          "the other end.",
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The catalogue is complete against §18.2's and §18.3's own row counts.
 *
 * A count assertion is worth its weight here because the failure it catches — a row
 * silently dropped during a refactor — produces no test failure anywhere else: the
 * missing row simply never fires.
 *
 * @returns {{ ok: boolean, problems: string[], agentRows: number, infraRows: number }}
 */
function assertCatalogueIsComplete() {
  const problems = [];

  /** §18.2 tabulates A1–A20. @structural the specification's own row count */
  const EXPECTED_AGENT_ROWS = 20;
  /** §18.3 tabulates B1–B20. @structural the specification's own row count */
  const EXPECTED_INFRA_ROWS = 20;

  if (agentFailures.AGENT_FAILURES.length !== EXPECTED_AGENT_ROWS) {
    problems.push(`§18.2 has ${EXPECTED_AGENT_ROWS} rows; the catalogue carries ${agentFailures.AGENT_FAILURES.length}`);
  }
  if (infraFailures.INFRA_FAILURES.length !== EXPECTED_INFRA_ROWS) {
    problems.push(`§18.3 has ${EXPECTED_INFRA_ROWS} rows; the catalogue carries ${infraFailures.INFRA_FAILURES.length}`);
  }

  for (let n = 1; n <= EXPECTED_AGENT_ROWS; n += 1) {
    if (!lookup(`A${n}`)) problems.push(`A${n} is missing from §18.2's half of the catalogue`);
  }
  for (let n = 1; n <= EXPECTED_INFRA_ROWS; n += 1) {
    if (!lookup(`B${n}`)) problems.push(`B${n} is missing from §18.3's half of the catalogue`);
  }

  return {
    ok: problems.length === 0,
    problems,
    agentRows: agentFailures.AGENT_FAILURES.length,
    infraRows: infraFailures.INFRA_FAILURES.length,
  };
}

/**
 * Every assertion this module makes, plus §18.4's.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertCatalogue() {
  const results = [
    assertCatalogueIsComplete(),
    assertEveryFailureHasADetector(),
    assertEveryLatencyIsBounded(),
    assertEveryFailureHasAResponse(),
    assertCustodyAwareRowsSplitTheirResponse(),
    assertModeJoinIsTotal(),
    infraFailures.assertNoRowFailsCustomerWork(),
  ];
  const problems = results.flatMap((result) => result.problems);
  return { ok: problems.length === 0, problems };
}

module.exports = {
  FAILURE_CLASS,
  CATALOGUE,
  CATALOGUE_IDS,
  lookup,
  alertingFor,
  strandingClassifyingRows,
  assertEveryFailureHasADetector,
  assertEveryLatencyIsBounded,
  assertEveryFailureHasAResponse,
  assertCustodyAwareRowsSplitTheirResponse,
  assertModeJoinIsTotal,
  assertCatalogueIsComplete,
  assertCatalogue,
};
