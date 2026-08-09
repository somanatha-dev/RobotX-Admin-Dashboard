"use strict";

/**
 * Engine lane — guards against the two ways the calibration gate could be closed wrongly.
 *
 * `tools/gates/checkCalibration.js` is strong in the direction it was built for: a
 * Safety-class entry that is not `DERIVED` blocks, and one that claims `DERIVED` without
 * stating a derivation blocks too. What it cannot check is whether a stated derivation is the
 * *right kind* of derivation, and §22.4 predicts exactly that failure:
 *
 * > Calibration ships with placeholder coefficients; operators lose trust and override
 * > constantly — execution plan §6.2, likelihood **High**, impact **High**
 *
 * Three of the 39 blocking Safety-class entries have a disposition the architecture already
 * states, and for each of them there is a wrong closure that would pass the gate. These tests
 * refuse the wrong closure without asserting that the entry is still open — so they need no
 * update on the day it is closed correctly, and they fail on the day it is closed incorrectly.
 *
 * Nothing here derives a value, changes a status, or moves the gate. All three entries remain
 * blocking, and closing any of them is a §22.3 Safety-class change with two-person approval
 * and an audit trail, not a test edit.
 */

const service = require("../../src/engine/config/service");
const gates = require("../../src/engine/cutover/gates");

const entryFor = (name) => service.loadRegister().entries.get(name);

/**
 * The two `legacy.dtaro.*` entries whose architecture-sanctioned disposition is **retirement,
 * not derivation**. Their own descriptions say so:
 *
 * > A percentage floor cannot express a tail requirement and is **replaced, not re-tuned**.
 *
 * Deriving a percentage for either would be actively wrong — a plausible number in a field
 * the architecture has already replaced — and it would close a blocking Safety finding on it.
 */
const RETIRED_BY_DISPOSITION = Object.freeze([
  "legacy.dtaro.battery_threshold_pct",
  "legacy.dtaro.charging_interrupt_battery_pct",
]);

describe("the two legacy.dtaro entries keep their retirement disposition", () => {
  test.each(RETIRED_BY_DISPOSITION)("%s still records replacement rather than re-tuning", (name) => {
    const entry = entryFor(name);
    expect(entry).toBeTruthy();

    // The disposition, in the three places the register states it. A change to any of them is
    // a change to what closing this entry means, and should be made deliberately.
    expect(entry.legacy.retiredInPhase).toBe(15);
    expect(entry.legacy.replacedBy).toBeTruthy();
    expect(entry.awaits).toMatch(/replacement by/);
  });

  test.each(RETIRED_BY_DISPOSITION)(
    "%s may not be closed by deriving a percentage — only by recording the replacement",
    (name) => {
      const entry = entryFor(name);
      if (entry.calibrationStatus !== "DERIVED") {
        // Still open, which is the current and correct state. Nothing to check: the gate
        // already blocks it, and this test exists for the other branch.
        expect(entry.calibrationStatus).toBe("UNCALIBRATED");
        return;
      }

      // The branch that matters. If somebody marks it DERIVED, the derivation must be the
      // retirement the architecture states — naming the replacement — and not a measurement of
      // the percentage the architecture has already rejected as unable to express the
      // requirement.
      expect(typeof entry.derivation).toBe("string");
      expect(entry.derivation).toMatch(new RegExp(entry.legacy.replacedBy.split(" ")[0], "i"));
      expect(entry.derivation).toMatch(/retire|replac/i);
    },
  );

  test("the only remaining consumer of either is the simulator, never the decision path", () => {
    // §22.3's precondition for retiring the second entry: repoint the one consumer first. The
    // consumer being `src/simulation/constants.js` — the simulator, not `feasibility/` — is
    // what makes the retirement a paperwork step rather than a behavioural change, and this
    // asserts that has not quietly stopped being true.
    for (const name of RETIRED_BY_DISPOSITION) {
      const consumers = entryFor(name).legacy.consumers || [];
      for (const consumer of consumers) {
        expect({ name, consumer, simulationOnly: consumer.startsWith("src/simulation/") }).toEqual({
          name,
          consumer,
          simulationOnly: true,
        });
      }
    }
  });
});

describe("sim.max_optimistic_bias — the circular derivation is refused", () => {
  test("the circularity is real: the parameter awaits the study, and the gate compares against the parameter", () => {
    // Recorded rather than assumed. `PHASE_15_BLOCKER_RESOLUTION_PLAN.md` §5.4(a) identified
    // this and it is unchanged: a tolerance cannot be an output of the study it bounds.
    const entry = entryFor("sim.max_optimistic_bias");
    expect(entry.awaits).toMatch(/fidelity study/i);

    const gate = gates.RELEASE_GATES.find((row) => row.id === "simulator_fidelity");
    expect(gate).toBeTruthy();
    expect(gate.statement).toMatch(/sim\.max_optimistic_bias/);
  });

  test("it may not be closed by citing the fidelity study — it is a Safety tolerance decision", () => {
    const entry = entryFor("sim.max_optimistic_bias");
    if (entry.calibrationStatus !== "DERIVED") {
      expect(entry.calibrationStatus).toBe("PROVISIONAL");
      return;
    }

    // §24.4 is unambiguous about what the parameter *is*: the largest optimistic bias Safety
    // will accept before refusing to let the simulator discharge a Tier 0 obligation. A
    // derivation that cites the study it bounds would be the circle closed rather than broken,
    // and it would pass `checkCalibration.js`, which only checks that a derivation exists.
    expect(typeof entry.derivation).toBe("string");
    expect(entry.derivation).not.toMatch(/fidelity study/i);
    expect(entry.awaits).not.toMatch(/fidelity study/i);
  });
});

describe("the gate's own strength is unchanged by any of this", () => {
  test("all 39 Safety-class findings still block, and the count is not asserted downward anywhere here", () => {
    const register = service.loadRegister();
    const safetyNotDerived = [...register.entries.values()].filter(
      (entry) => entry.changeClass === "SAFETY" && entry.calibrationStatus !== "DERIVED",
    );
    // Asserted as a floor rather than an equality: this file must never be the reason a
    // reduction in the count looks approved. The exact figure belongs to the gate.
    expect(safetyNotDerived.length).toBeGreaterThan(0);
    expect(register.entries.get("sim.max_optimistic_bias").changeClass).toBe("SAFETY");
    for (const name of RETIRED_BY_DISPOSITION) expect(entryFor(name).changeClass).toBe("SAFETY");
  });
});
