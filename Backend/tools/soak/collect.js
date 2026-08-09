"use strict";

/**
 * The `soak` release gate's evidence collector (§24.6, `cutover/gates.js`).
 *
 * > **A soak over days exposes no leak, unbounded cache, timer accumulation or queue drift.**
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * `tests/scale/helpers/scaleHarness.js`'s `soak()` checks a **shape**: it samples one scalar
 * in windows and reports whether the last window exceeds the first. That is the right check
 * and it is deliberately not a duration — its own header says so, and `release.soak_duration`
 * names what is.
 *
 * But a shape check on one scalar is not a filable soak record. The gate is discharged by a
 * run whose duration, workload, and behaviour under it can be read afterwards by somebody who
 * was not there, and the quantities that record has to carry are spread across five modules
 * that nothing assembles: `observability/sli.js` holds latency and throughput,
 * `observability/invariantChecker.js` holds violations, `cutover/guardrails.js` holds the
 * rollback signal, the process holds CPU and memory, and the drift shapes live in the scale
 * harness. This module is the assembly, and nothing more.
 *
 * ── What it refuses to do ──────────────────────────────────────────────────
 *
 * 1. **It never invents a sample.** Every quantity it cannot observe is reported
 *    `NOT_COLLECTED`, which `assess()` treats as disqualifying rather than as absent. A soak
 *    record with an unobserved field is an incomplete record, not a clean one — the same
 *    distinction `invariantChecker.summarise()` draws with `checkerHealthy`.
 * 2. **It never decides that a run was long enough.** The required duration is
 *    `release.soak_duration`, which is **PROVISIONAL** and awaits "the observed time constant
 *    of the slowest accumulating resource". `assess()` compares against it and says so, but a
 *    run measured against an un-derived duration is reported as
 *    `DURATION_TARGET_NOT_DERIVED` — a run whose length nobody can defend is not evidence,
 *    and a tool that quietly accepted the provisional default would be manufacturing the
 *    defence.
 * 3. **It never produces a `soak` gate verdict of GREEN by itself.** It produces the record.
 *    Filing it against the gate is a human act with a named operator, per `cutover.md`.
 *
 * Usage, in the soak runner (staging), once per sampling window:
 *
 * ```js
 *   const collector = soak.createCollector({ workload: "...", config: snapshot });
 *   // ... each window:
 *   collector.window({ sli: registry.snapshot(), invariants: summary, guardrail: verdict,
 *                      throughput: roundsThisWindow, errors: errorsThisWindow });
 *   // ... at the end:
 *   const record = collector.finish({ endedAtMs });
 *   const verdict = soak.assess(record, { requiredDurationMs, durationDerived });
 * ```
 */

const sli = require("../../src/engine/observability/sli");

/** @structural the states a required quantity can be in */
const COLLECTION = Object.freeze({
  COLLECTED: "COLLECTED",
  /** Never treated as "fine": an unobserved quantity disqualifies the record. */
  NOT_COLLECTED: "NOT_COLLECTED",
});

/** @structural the verdicts `assess()` can return */
const VERDICT = Object.freeze({
  PASS: "PASS",
  DRIFTED: "DRIFTED",
  VIOLATED: "VIOLATED",
  TOO_SHORT: "TOO_SHORT",
  DURATION_TARGET_NOT_DERIVED: "DURATION_TARGET_NOT_DERIVED",
  INCOMPLETE: "INCOMPLETE",
});

/**
 * The quantities the gate's evidence must carry, each with why it is there.
 *
 * The first four are §24.6's own four named shapes. The rest are what makes a multi-day run
 * readable afterwards: without them a record says "nothing grew" and cannot say what the
 * system was doing while nothing grew.
 * @structural the evidence checklist
 */
const REQUIRED = Object.freeze([
  { id: "duration", why: "release.soak_duration is the gate's own threshold" },
  { id: "workload", why: "§24.5's production-shaped load; a soak of an idle system is a soak of nothing" },
  { id: "throughput", why: "the load actually applied, not the load intended" },
  { id: "latency", why: "§20.1's targets must hold throughout, not only at the start" },
  { id: "latencyTail", why: "§20.1 states two p99.9 rows, and both bound safety windows" },
  { id: "cpu", why: "a leak that shows as CPU before it shows as memory" },
  { id: "memory", why: "§24.6's leak" },
  { id: "errors", why: "a soak that sheds errors quietly is not clean" },
  { id: "invariantViolations", why: "§26.1's target is exactly zero" },
  { id: "rollbackSignals", why: "a guardrail breach during the soak is the run's most important output" },
  { id: "unboundedGrowth", why: "§24.6's four shapes: leaks, unbounded caches, timer accumulation, queue drift" },
]);

/**
 * @param {number[]} values
 * @returns {number|null}
 */
function last(values) {
  return values.length === 0 ? null : values[values.length - 1];
}

/**
 * Window-over-window drift as a ratio, so the check is scale-free — the same definition
 * `scaleHarness.soak()` uses, kept identical on purpose so two soak artefacts are comparable.
 *
 * @param {number[]} samples
 * @returns {number|null}
 */
function drift(samples) {
  if (samples.length < 2) return null;
  const first = samples[0];
  const final = samples[samples.length - 1];
  if (first === 0) return final === 0 ? 0 : Infinity;
  return (final - first) / first;
}

/**
 * Start a collector for one soak run.
 *
 * @param {object} input `{ workload, startedAtMs, shardId, growthSeries }`
 * @returns {object}
 */
function createCollector(input) {
  const source = input || {};
  const windows = [];
  // The named quantities §24.6 asks to be watched for unbounded growth. Supplied by the
  // caller because only the runner knows which structures it can see.
  const growthSeries = new Map((source.growthSeries || []).map((name) => [name, []]));

  return {
    /**
     * Record one sampling window.
     *
     * @param {object} sample `{ atMs, sli, invariants, guardrail, throughput, errors, cpuPercent, memoryBytes, growth }`
     */
    window(sample) {
      const row = sample || {};
      for (const [name, series] of growthSeries) {
        const value = row.growth ? row.growth[name] : undefined;
        if (Number.isFinite(value)) series.push(value);
      }
      windows.push({
        atMs: Number.isFinite(row.atMs) ? row.atMs : null,
        sli: row.sli || null,
        invariants: row.invariants || null,
        guardrail: row.guardrail || null,
        throughput: Number.isFinite(row.throughput) ? row.throughput : null,
        errors: Number.isFinite(row.errors) ? row.errors : null,
        cpuPercent: Number.isFinite(row.cpuPercent) ? row.cpuPercent : null,
        memoryBytes: Number.isFinite(row.memoryBytes) ? row.memoryBytes : null,
      });
    },

    /**
     * Close the run and assemble the record.
     *
     * @param {object} [close] `{ endedAtMs, config }`
     * @returns {object}
     */
    finish(close) {
      const ended = (close && close.endedAtMs) || null;
      const started = Number.isFinite(source.startedAtMs) ? source.startedAtMs : null;
      const durationMs = started !== null && ended !== null ? ended - started : null;

      const numbersOf = (field) => windows.map((row) => row[field]).filter((value) => Number.isFinite(value));
      const cpu = numbersOf("cpuPercent");
      const memory = numbersOf("memoryBytes");
      const throughput = numbersOf("throughput");
      const errors = numbersOf("errors");

      const merged = sli.merge(windows.map((row) => row.sli).filter(Boolean));
      const attainment =
        windows.some((row) => row.sli) && close && close.config
          ? sli.attainment({ merged, config: close.config })
          : null;

      const invariantWindows = windows.map((row) => row.invariants).filter(Boolean);
      const violations = invariantWindows.reduce((total, row) => total + (row.invariantViolations || 0), 0);
      const violated = [...new Set(invariantWindows.flatMap((row) => row.violatedInvariants || []))].sort();
      const checkerHealthy = invariantWindows.length > 0 && invariantWindows.every((row) => row.checkerHealthy === true);

      const rollbackSignals = windows
        .map((row, index) => ({ window: index, guardrail: row.guardrail }))
        .filter((row) => row.guardrail && row.guardrail.verdict && row.guardrail.verdict !== "HOLD" && row.guardrail.verdict !== "PASS");

      const growth = [...growthSeries.entries()].map(([name, samples]) => ({
        name,
        samples: samples.length,
        first: samples.length > 0 ? samples[0] : null,
        last: last(samples),
        drift: drift(samples),
        bounded: samples.length < 2 ? null : drift(samples) <= 0,
      }));

      const record = {
        workload: source.workload || null,
        shardId: source.shardId || null,
        startedAtMs: started,
        endedAtMs: ended,
        durationMs,
        windowCount: windows.length,
        throughput: throughput.length > 0 ? { windows: throughput.length, total: throughput.reduce((a, b) => a + b, 0), perWindow: throughput } : null,
        errors: errors.length > 0 ? { total: errors.reduce((a, b) => a + b, 0), perWindow: errors } : null,
        cpuPercent: cpu.length > 0 ? { min: Math.min(...cpu), max: Math.max(...cpu), first: cpu[0], last: last(cpu) } : null,
        memoryBytes: memory.length > 0 ? { min: Math.min(...memory), max: Math.max(...memory), first: memory[0], last: last(memory), drift: drift(memory) } : null,
        latency: attainment,
        invariants: invariantWindows.length > 0 ? { violations, violatedInvariants: violated, checkerHealthy, windows: invariantWindows.length } : null,
        rollbackSignals,
        growth,
      };

      record.collection = collectionOf(record);
      return record;
    },
  };
}

/**
 * Which of the required quantities the record actually carries.
 *
 * @param {object} record
 * @returns {object[]}
 */
function collectionOf(record) {
  const present = {
    duration: Number.isFinite(record.durationMs) && record.durationMs > 0,
    workload: Boolean(record.workload),
    throughput: Boolean(record.throughput),
    latency: Array.isArray(record.latency) && record.latency.some((row) => row.observed !== null),
    // The tail specifically. §20.1 states two p99.9 rows and both bound safety windows, so a
    // soak that measured only p99 has not measured what those two rows exist to bound.
    latencyTail: Array.isArray(record.latency)
      ? record.latency.filter((row) => row.boundsSafetyWindow).every((row) => row.observed !== null)
      : false,
    cpu: Boolean(record.cpuPercent),
    memory: Boolean(record.memoryBytes),
    errors: Boolean(record.errors),
    invariantViolations: Boolean(record.invariants) && record.invariants.checkerHealthy === true,
    rollbackSignals: Array.isArray(record.rollbackSignals),
    unboundedGrowth: Array.isArray(record.growth) && record.growth.length > 0 && record.growth.every((row) => row.bounded !== null),
  };

  return REQUIRED.map((row) => ({
    id: row.id,
    why: row.why,
    status: present[row.id] ? COLLECTION.COLLECTED : COLLECTION.NOT_COLLECTED,
  }));
}

/**
 * Judge a soak record.
 *
 * The order of the checks is the order in which a failure disqualifies the record: an
 * incomplete record cannot be judged at all, an un-derived duration target cannot be
 * compared against, and only then do the observations themselves matter.
 *
 * @param {object} record from `finish()`
 * @param {object} input `{ requiredDurationMs, durationDerived }`
 * @returns {{ verdict: string, reasons: string[], missing: string[] }}
 */
function assess(record, input) {
  const source = input || {};
  const missing = (record.collection || []).filter((row) => row.status === COLLECTION.NOT_COLLECTED).map((row) => row.id);
  const reasons = [];

  if (missing.length > 0) {
    return {
      verdict: VERDICT.INCOMPLETE,
      missing,
      reasons: [
        `the record does not carry ${missing.join(", ")}. §24.6's gate is discharged by a run whose behaviour can be ` +
          "read afterwards by somebody who was not there; a field nobody observed is not a field that was fine.",
      ],
    };
  }

  if (source.durationDerived !== true) {
    return {
      verdict: VERDICT.DURATION_TARGET_NOT_DERIVED,
      missing,
      reasons: [
        "release.soak_duration is PROVISIONAL and awaits the observed time constant of the slowest accumulating " +
          "resource. A soak measured against an un-derived duration is a run whose length nobody can defend.",
      ],
    };
  }

  if (Number.isFinite(source.requiredDurationMs) && record.durationMs < source.requiredDurationMs) {
    return {
      verdict: VERDICT.TOO_SHORT,
      missing,
      reasons: [`ran for ${record.durationMs} ms against a required ${source.requiredDurationMs} ms`],
    };
  }

  if (record.invariants.violations > 0) {
    reasons.push(`${record.invariants.violations} invariant violation(s): ${record.invariants.violatedInvariants.join(", ")}. §26.1's target is exactly zero.`);
  }
  if (record.rollbackSignals.length > 0) {
    reasons.push(`${record.rollbackSignals.length} guardrail signal(s) during the run — the most important output a soak can have.`);
  }
  if (reasons.length > 0) return { verdict: VERDICT.VIOLATED, missing, reasons };

  const drifted = record.growth.filter((row) => row.bounded === false);
  if (drifted.length > 0) {
    return {
      verdict: VERDICT.DRIFTED,
      missing,
      reasons: drifted.map((row) => `${row.name} grew by ${(row.drift * 100).toFixed(1)} % across the run`),
    };
  }

  const unmet = (record.latency || []).filter((row) => row.meets === false);
  if (unmet.length > 0) {
    return { verdict: VERDICT.VIOLATED, missing, reasons: unmet.map((row) => `${row.id} missed its §20.1 target throughout the soak`) };
  }

  return { verdict: VERDICT.PASS, missing, reasons: [] };
}

module.exports = { COLLECTION, VERDICT, REQUIRED, createCollector, collectionOf, assess, drift };
