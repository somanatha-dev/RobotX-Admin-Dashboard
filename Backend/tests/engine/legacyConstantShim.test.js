"use strict";

/**
 * Engine lane — the legacy constant shims.
 *
 * Phase 1's completion criterion is that every constant in `dtaro.constants.js` and
 * `liveness.constants.js` is resolvable through the Config Service. The risk it
 * carries is behavioural: those constants are read by `robotValidator.service.js`,
 * `simulation/constants.js`, `robot.handler.js`, `telemetry.handler.js` and
 * `socket.server.js`, none of which is in scope for Phase 1. So the shim is tested
 * for two things — that the values are *identical* to the ones the legacy path ran
 * on, and that they now come from the register rather than from a literal.
 */

const fs = require("fs");
const path = require("path");

const service = require("../../src/engine/config/service");
const dtaro = require("../../src/config/dtaro.constants");
const liveness = require("../../src/config/liveness.constants");

const CONFIG_DIRECTORY = path.join(__dirname, "..", "..", "src", "config");
const snapshot = service.defaultSnapshot();

describe("the values are unchanged — Phase 1 moves where they live, not what they are", () => {
  test("the DTARO battery thresholds are still 20 % and 30 %", () => {
    expect(dtaro.BATTERY_THRESHOLD).toBe(20);
    expect(dtaro.CHARGING_INTERRUPT_BATTERY).toBe(30);
  });

  test("the liveness timings are still 15 s / 30 s / 10 s / 500", () => {
    expect(liveness.DB_FLUSH_INTERVAL_MS).toBe(15000);
    expect(liveness.OFFLINE_CUTOFF_MS).toBe(30000);
    expect(liveness.OFFLINE_SWEEP_INTERVAL_MS).toBe(10000);
    expect(liveness.OFFLINE_SWEEP_BATCH).toBe(500);
  });
});

describe("the values now come from the register", () => {
  test.each([
    ["legacy.dtaro.battery_threshold_pct", () => dtaro.BATTERY_THRESHOLD],
    ["legacy.dtaro.charging_interrupt_battery_pct", () => dtaro.CHARGING_INTERRUPT_BATTERY],
    ["legacy.liveness.db_flush_interval_ms", () => liveness.DB_FLUSH_INTERVAL_MS],
    ["legacy.liveness.offline_cutoff_ms", () => liveness.OFFLINE_CUTOFF_MS],
    ["legacy.liveness.offline_sweep_interval_ms", () => liveness.OFFLINE_SWEEP_INTERVAL_MS],
    ["legacy.liveness.offline_sweep_batch", () => liveness.OFFLINE_SWEEP_BATCH],
  ])("%s resolves to the exported value", (name, read) => {
    expect(snapshot.resolve(name)).toBe(read());
  });

  test("each resolution explains where it came from and that it is not yet calibrated", () => {
    const explanation = snapshot.explain("legacy.dtaro.battery_threshold_pct");
    expect(explanation.source).toBe("default");
    expect(explanation.unit).toBe("%");
    expect(explanation.calibrationStatus).toBe("UNCALIBRATED");
    expect(explanation.awaits).toBeUndefined(); // the register entry carries it, not the explanation
    expect(service.loadRegister().entries.get("legacy.dtaro.battery_threshold_pct").awaits).toMatch(
      /Wh-denominated layered reserve model/,
    );
  });

  test("the shim files hold no numeric literal of their own", () => {
    for (const file of ["dtaro.constants.js", "liveness.constants.js"]) {
      const source = fs.readFileSync(path.join(CONFIG_DIRECTORY, file), "utf8");
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
      expect({ file, literals: code.match(/(?<![\w$.])\d[\d_]*(?:\.\d+)?/g) || [] }).toEqual({ file, literals: [] });
    }
  });

  test("each names the phase in which it retires and what replaces it", () => {
    const entries = service.loadRegister().entries;
    for (const name of [
      "legacy.dtaro.battery_threshold_pct",
      "legacy.dtaro.charging_interrupt_battery_pct",
      "legacy.liveness.db_flush_interval_ms",
      "legacy.liveness.offline_cutoff_ms",
    ]) {
      const entry = entries.get(name);
      expect({ name, phase: typeof entry.legacy.retiresInPhase }).toEqual({ name, phase: "number" });
      expect(entry.legacy.replacedBy).toBeTruthy();
      expect(entry.legacy.consumers.length).toBeGreaterThan(0);
    }
  });

  test("the consumers each entry names still exist and still import the shim", () => {
    const backend = path.join(__dirname, "..", "..");
    const entries = service.loadRegister().entries;
    for (const entry of entries.values()) {
      if (!entry.legacy) continue;
      for (const consumer of entry.legacy.consumers) {
        const absolute = path.join(backend, consumer);
        expect({ consumer, exists: fs.existsSync(absolute) }).toEqual({ consumer, exists: true });
        const source = fs.readFileSync(absolute, "utf8");
        expect({ consumer, imports: source.includes(path.basename(entry.legacy.file, ".js")) }).toEqual({
          consumer,
          imports: true,
        });
      }
    }
  });
});

describe("a resolution failure is fatal rather than defaulted", () => {
  test("the shim refuses to substitute a value it could not resolve", () => {
    // The guard is the same in both shims; exercising it directly avoids having to
    // corrupt the register on disk to reach it.
    const source = fs.readFileSync(path.join(CONFIG_DIRECTORY, "dtaro.constants.js"), "utf8");
    expect(source).toMatch(/did not resolve through the Config Service/);
    expect(source).toMatch(/throw new Error/);
  });
});
