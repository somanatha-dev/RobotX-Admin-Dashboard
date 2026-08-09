"use strict";

/**
 * Engine lane — Phase 12: obstruction classification (§4.3, §5.2) and invariant I22.
 *
 * The plan's Phase 12 testing row names one unit test explicitly — "obstruction class
 * `INDETERMINATE` resolves to `STRANDED_OBSTRUCTING`" — because that single resolution is
 * what makes the difference between an unnecessary callout and an incident. It is checked
 * here in all three ways a class becomes indeterminate, and in the two derived decisions
 * that read it: A10's choice of stopping location and §18.6 step 5's re-evaluation.
 */

const obstructionClass = require("../../src/engine/map/obstructionClass");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const work = require("../../src/engine/domain/work");

const NOW = 1770000000000;
const MAX_AGE = 300;

describe("§4.3 — INDETERMINATE resolves to STRANDED_OBSTRUCTING", () => {
  test("when the Map service returns nothing", () => {
    const outcome = obstructionClass.classify({ hazardData: null, nowMs: NOW, maxAgeSeconds: MAX_AGE });
    expect(outcome.obstructionClass).toBe("INDETERMINATE");
    expect(outcome.legState).toBe(legMachine.LEG_STATE.STRANDED_OBSTRUCTING);
    expect(outcome.externalEscalation).toBe(true);
    expect(outcome.indeterminacyCause).toBe(obstructionClass.INDETERMINACY_CAUSE.UNAVAILABLE);
  });

  test("when the hazard data is stale beyond its budget", () => {
    const outcome = obstructionClass.classify({
      hazardData: { obstructionClass: "CLEAR", observedAtMs: NOW - (MAX_AGE + 60) * 1000 },
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    // A *stale* CLEAR is not a CLEAR. §4.3 defines INDETERMINATE as "unavailable **or stale
    // beyond its budget**", and this is the case that would otherwise slip through as a
    // confident answer from an old reading.
    expect(outcome.obstructionClass).toBe("INDETERMINATE");
    expect(outcome.legState).toBe(legMachine.LEG_STATE.STRANDED_OBSTRUCTING);
    expect(outcome.indeterminacyCause).toBe(obstructionClass.INDETERMINACY_CAUSE.STALE);
    expect(outcome.reportedClass).toBe("CLEAR");
  });

  test("when the class is a label this build does not recognise", () => {
    const outcome = obstructionClass.classify({
      hazardData: { obstructionClass: "MOSTLY_FINE", observedAtMs: NOW },
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.obstructionClass).toBe("INDETERMINATE");
    expect(outcome.indeterminacyCause).toBe(obstructionClass.INDETERMINACY_CAUSE.UNRECOGNISED);
  });

  test("when the data carries no usable observation time", () => {
    const outcome = obstructionClass.classify({
      hazardData: { obstructionClass: "CLEAR" },
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.obstructionClass).toBe("INDETERMINATE");
    expect(outcome.detail).toMatch(/Unknown freshness is not fresh/);
  });

  test("the three causes are distinguished, because they are three different defects", () => {
    // A gap in map coverage, a stale publication pipeline, and a version skew produce one
    // identical operational symptom and need three different fixes.
    expect(Object.keys(obstructionClass.INDETERMINACY_CAUSE).sort()).toEqual(["STALE", "UNAVAILABLE", "UNRECOGNISED"]);
  });
});

describe("§4.3 — the three determinate classes", () => {
  const fresh = (name) => obstructionClass.classify({
    hazardData: { obstructionClass: name, observedAtMs: NOW - 1000, source: "MAP-V7" },
    nowMs: NOW,
    maxAgeSeconds: MAX_AGE,
  });

  test("CLEAR and RESTRICTIVE both produce STRANDED_SAFE, with different response targets", () => {
    expect(fresh("CLEAR").legState).toBe(legMachine.LEG_STATE.STRANDED_SAFE);
    expect(fresh("RESTRICTIVE").legState).toBe(legMachine.LEG_STATE.STRANDED_SAFE);
    // Same state, different SLA — §4.3 gives RESTRICTIVE a tighter target because it
    // impedes without blocking.
    expect(fresh("CLEAR").responseTargetParameter).toBe("ops.stranded_safe_response_target");
    expect(fresh("RESTRICTIVE").responseTargetParameter).toBe("ops.stranded_restrictive_response_target");
  });

  test("BLOCKING_CRITICAL produces STRANDED_OBSTRUCTING and opens the §18.6 chain", () => {
    const outcome = fresh("BLOCKING_CRITICAL");
    expect(outcome.legState).toBe(legMachine.LEG_STATE.STRANDED_OBSTRUCTING);
    expect(outcome.externalEscalation).toBe(true);
    expect(outcome.responseTargetParameter).toBe("ops.stranded_obstructing_response_target");
  });

  test("every determinate result records that it was not operator-entered", () => {
    // §4.3: "derived automatically, **never operator-entered**". Recorded per result so an
    // I22 audit can establish provenance from the record alone — and `classify()` takes no
    // operator argument, so there is no shape by which one could be.
    expect(fresh("CLEAR").operatorEntered).toBe(false);
    expect(fresh("CLEAR").mapSource).toBe("MAP-V7");
  });

  test("the classifier's vocabulary is the domain model's, not a second copy", () => {
    expect(Object.keys(obstructionClass.OBSTRUCTION_CLASS).sort()).toEqual([...work.OBSTRUCTION_CLASS_NAMES].sort());
  });
});

describe("§18.2 A10 — the lowest obstruction class reachable", () => {
  const location = (id, name, distanceM) => ({
    locationId: id,
    distanceM,
    hazardData: name === null ? null : { obstructionClass: name, observedAtMs: NOW - 1000 },
  });

  test("class dominates distance — a far CLEAR beats a near BLOCKING_CRITICAL", () => {
    // "the choice of stopping location is made against the map's obstruction
    // classification, **not merely against distance**". A naive nearest-stop rule inverts
    // exactly this.
    const outcome = obstructionClass.lowestReachable({
      reachable: [location("near", "BLOCKING_CRITICAL", 20), location("far", "CLEAR", 900)],
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.chosen.locationId).toBe("far");
    expect(outcome.onlyBlockingCriticalReachable).toBe(false);
    expect(outcome.externalEscalation).toBe(false);
  });

  test("distance is the tie-break within a class", () => {
    const outcome = obstructionClass.lowestReachable({
      reachable: [location("a", "CLEAR", 400), location("b", "CLEAR", 100)],
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.chosen.locationId).toBe("b");
  });

  test("a reachable set of nothing but BLOCKING_CRITICAL opens the §18.6 chain", () => {
    const outcome = obstructionClass.lowestReachable({
      reachable: [location("a", "BLOCKING_CRITICAL", 20), location("b", "BLOCKING_CRITICAL", 90)],
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.onlyBlockingCriticalReachable).toBe(true);
    expect(outcome.externalEscalation).toBe(true);
    expect(outcome.reason).toMatch(/before the stop rather than after it/);
  });

  test("a set of nothing but unknowns is not a set with a safe option in it", () => {
    // The INDETERMINATE resolution carried into A10: unclassifiable locations resolve to
    // STRANDED_OBSTRUCTING, so escalating is the correct reading of "no safe stop".
    const outcome = obstructionClass.lowestReachable({
      reachable: [location("a", null, 20), location("b", null, 90)],
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.onlyBlockingCriticalReachable).toBe(true);
    expect(outcome.externalEscalation).toBe(true);
  });

  test("an empty reachable set escalates rather than reporting success", () => {
    const outcome = obstructionClass.lowestReachable({ reachable: [], nowMs: NOW, maxAgeSeconds: MAX_AGE });
    expect(outcome.chosen).toBeNull();
    expect(outcome.externalEscalation).toBe(true);
  });

  test("INDETERMINATE sorts at the top of the severity order, never below RESTRICTIVE", () => {
    expect(obstructionClass.SEVERITY_ORDER).toEqual(["CLEAR", "RESTRICTIVE", "BLOCKING_CRITICAL", "INDETERMINATE"]);
    expect(obstructionClass.severityOf("INDETERMINATE")).toBeGreaterThan(obstructionClass.severityOf("RESTRICTIVE"));
  });
});

describe("§18.6 step 5 — re-evaluation", () => {
  test("de-escalates when the agent is moved clear", () => {
    const outcome = obstructionClass.reclassify({
      currentClass: "BLOCKING_CRITICAL",
      hazardData: { obstructionClass: "CLEAR", observedAtMs: NOW - 500 },
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.deEscalated).toBe(true);
    expect(outcome.legStateChange).toEqual({ from: "STRANDED_OBSTRUCTING", to: "STRANDED_SAFE" });
  });

  test("escalates when fresh data is worse", () => {
    const outcome = obstructionClass.reclassify({
      currentClass: "CLEAR",
      hazardData: { obstructionClass: "BLOCKING_CRITICAL", observedAtMs: NOW - 500 },
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.escalated).toBe(true);
    expect(outcome.legStateChange).toEqual({ from: "STRANDED_SAFE", to: "STRANDED_OBSTRUCTING" });
  });

  test("cannot de-escalate on absent data — absent data is INDETERMINATE, which only escalates", () => {
    const outcome = obstructionClass.reclassify({
      currentClass: "BLOCKING_CRITICAL",
      hazardData: null,
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.deEscalated).toBe(false);
    expect(outcome.changed).toBe(true);
    expect(outcome.after.legState).toBe(legMachine.LEG_STATE.STRANDED_OBSTRUCTING);
    expect(outcome.deEscalationRequiresPositiveEvidence).toBe(true);

    // The same, from the other side: a RESTRICTIVE stranding whose map data goes away
    // escalates rather than staying put.
    const worsened = obstructionClass.reclassify({ currentClass: "RESTRICTIVE", hazardData: null, nowMs: NOW, maxAgeSeconds: MAX_AGE });
    expect(worsened.escalated).toBe(true);
  });

  test("reports no change when the classification is unchanged", () => {
    const outcome = obstructionClass.reclassify({
      currentClass: "BLOCKING_CRITICAL",
      hazardData: { obstructionClass: "BLOCKING_CRITICAL", observedAtMs: NOW - 500 },
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(outcome.changed).toBe(false);
    expect(outcome.legStateChange).toBeNull();
  });
});

describe("invariant I22 — the per-Leg audit", () => {
  test("a STRANDED_* Leg with no classification is a violation of the first clause", () => {
    const outcome = obstructionClass.auditLegClassification({ legId: "LEG-1", state: "STRANDED_SAFE", obstructionClass: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.problem).toMatch(/no obstruction classification/);
  });

  test("an obstructing class held in STRANDED_SAFE is a violation of the second clause", () => {
    // I22's second clause — "no obstructing stranding is held in the ordinary operations
    // queue" — is enforced by the state, so a mismatch routes it to the wrong queue.
    const outcome = obstructionClass.auditLegClassification({
      legId: "LEG-1",
      state: "STRANDED_SAFE",
      obstructionClass: "BLOCKING_CRITICAL",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.expectedState).toBe("STRANDED_OBSTRUCTING");
  });

  test("an INDETERMINATE class held in STRANDED_SAFE is the same violation", () => {
    const outcome = obstructionClass.auditLegClassification({
      legId: "LEG-1",
      state: "STRANDED_SAFE",
      obstructionClass: "INDETERMINATE",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.expectedState).toBe("STRANDED_OBSTRUCTING");
  });

  test("a matching pair passes, and a non-stranded Leg is out of scope", () => {
    expect(obstructionClass.auditLegClassification({ legId: "LEG-1", state: "STRANDED_SAFE", obstructionClass: "CLEAR" }).ok).toBe(true);
    expect(obstructionClass.auditLegClassification({ legId: "LEG-2", state: "EN_ROUTE_DROP", obstructionClass: null }).ok).toBe(true);
  });
});
