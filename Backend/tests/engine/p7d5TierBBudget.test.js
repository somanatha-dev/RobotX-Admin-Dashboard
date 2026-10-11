"use strict";

/**
 * P7-D5 D3 — one Tier B write budget per process, shared by the writer and the flusher.
 *
 * Found (P7-D5 evidence completeness audit, 2026-10-11), and re-traced before this change:
 *   · `server.js` built the flusher's budget with `createBudget({ perShardBudget })` — a key
 *     `createBudget` never read — so it was 0/0;
 *   · the coordinator's writer never received that budget and offered into its own lazily
 *     created singleton (`defaultRecordBudget`), which nothing drained: shedding was never
 *     audited and `sli.tier_b_shedding_count` never moved;
 *   · that singleton took its settings from whichever round created it first.
 *
 * Now: `createBudget` refuses keys it does not read; `budgetConfigFrom(values)` reads the two
 * register parameters; `server.js` creates ONE budget beside the rejection aggregator and hands
 * it to the coordinator (`leaderWorkers` → `deps.recordBudget`) and to the flusher; its settings
 * are fixed for the process's life.
 *
 * MOCKED BOUNDARY: the store (`roundFixture.memoryPrisma`). `server.js` cannot be booted here
 * (it connects to a database), so its wiring is checked in its source text.
 */

const fs = require("fs");
const path = require("path");

const sampling = require("../../src/engine/observability/sampling");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const configService = require("../../src/engine/config/service");
const coordinator = require("../../src/workers/coordinator.worker");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const tierBWorker = require("../../src/workers/tierB.worker");
const sli = require("../../src/engine/observability/sli");
const planState = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const leadership = require("../../src/engine/shard/leadership");
const fixture = require("./helpers/roundFixture");

const SHARD = "default";
const T0 = 1790000040000; // inside one budget minute
const DEGRADED = [{ scope: sampling.DEGRADATION_SCOPE.DECISION, reason: "STALE_TELEMETRY" }];

/** A round of `n` Legs, each exempt (a decision-scoped degradation) and carrying a Tier B input. */
function exemptRound(n, decisionTimeMs = T0, prefix = "LEG") {
  const legs = Array.from({ length: n }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}`);
  return {
    round: {
      roundId: `${SHARD}:${decisionTimeMs}`,
      shardId: SHARD,
      decisionTimeMs,
      regime: "SINGLETON",
      columns: { generated: 0, kept: 0, pruned: 0, bestPrunedGammaMilliCU: null },
      budgets: { budgetLimited: false, exceeded: [] },
      lpIpGapMilliCU: 0n,
      committed: [],
      decisions: legs.map((legId) => ({ legId, outcome: "NO_FEASIBLE_CANDIDATE" })),
    },
    perLeg: Object.fromEntries(legs.map((legId) => [legId, { candidates: [], degradations: DEGRADED, tierBInput: { candidates: [], columns: [], pruned: [] } }])),
  };
}

/** Write a round of exempt decisions against `budget`, with no random sample. */
async function writeExempt({ prisma, budget, n, decisionTimeMs = T0, prefix }) {
  const { round, perLeg } = exemptRound(n, decisionTimeMs, prefix);
  return decisionRecord.writeRound(
    { prisma },
    {
      round,
      context: { shardId: SHARD, snapshot: { snapshotId: round.roundId, pins: null, seed: "00" }, perLeg },
      budget,
      config: { sampleRate: 0, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30 },
      nowMs: decisionTimeMs,
    },
  );
}

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, "../../server.js"), "utf8");

/** `text` with its `//` and block comments removed (string literals are kept as they are). */
function withoutComments(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end - 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * The exact argument text of every `callee(...)` in `source`, comments removed, the closing
 * parenthesis found by depth — so an assertion about one call can never be satisfied by a later
 * one (an unbounded `[\s\S]*?` regex let `leaderWorkers.create`'s check match the
 * `startScheduledWorkers` call further down the file).
 *
 * @param {string} source
 * @param {string} callee e.g. "leaderWorkers.create"
 * @returns {Array<{ at: number, args: string }>}
 */
function callsOf(source, callee) {
  const code = withoutComments(source);
  const calls = [];
  const opener = `${callee}(`;
  for (let at = code.indexOf(opener); at >= 0; at = code.indexOf(opener, at + opener.length)) {
    // Not part of a longer identifier (`xleaderWorkers.create(`).
    if (at > 0 && /[\w$.]/.test(code[at - 1])) continue;
    let depth = 0;
    let i = at + callee.length;
    for (; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < code.length && code[j] !== ch) j += code[j] === "\\" ? 2 : 1;
        i = j;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push({ at, args: code.slice(at + opener.length, i) });
  }
  return calls;
}

/**
 * The TOP-LEVEL entries of a call whose single argument is an object literal, each trimmed —
 * nested objects and function bodies are part of their entry, never entries of their own.
 *
 * @param {string} args a `callsOf` argument text
 * @returns {string[]|null} null when the argument is not one object literal
 */
function topLevelEntries(args) {
  const text = args.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const entries = [];
  let depth = 0;
  let start = 1;
  for (let i = 1; i < text.length - 1; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      i = j;
    } else if ("({[".includes(ch)) {
      depth += 1;
    } else if (")}]".includes(ch)) {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      entries.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  entries.push(text.slice(start, text.length - 1).trim());
  return entries.filter((entry) => entry !== "");
}

/** Does this object-literal argument pass `name` itself (`name` or `name: name`) at its top level? */
function passesProperty(args, name) {
  const entries = topLevelEntries(args);
  return Array.isArray(entries) && entries.some((entry) => entry === name || new RegExp(`^${name}\\s*:\\s*${name}$`).test(entry));
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. The constructor's contract
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D3 — createBudget accepts only the options it reads", () => {
  test("perShardBudget — the key server.js used to pass — is refused, naming the real options", () => {
    expect(() => sampling.createBudget({ perShardBudget: 5000 })).toThrow(/does not accept "perShardBudget".*writeBudgetPerMinute, reservoirSize/);
    expect(() => sampling.createBudget({ writeBudgetPerMinute: 1, budget: 2 })).toThrow(/"budget"/);
  });

  test("the two real options are honoured; absent ones are 0 (fail-safe: fewer writes, all counted)", () => {
    expect(sampling.createBudget({ writeBudgetPerMinute: 7, reservoirSize: 3 }).counters(SHARD)).toMatchObject({ writeBudget: 7, reservoirSize: 3 });
    expect(sampling.createBudget({}).counters(SHARD)).toMatchObject({ writeBudget: 0, reservoirSize: 0 });
    expect(sampling.createBudget().counters(SHARD)).toMatchObject({ writeBudget: 0, reservoirSize: 0 });
  });

  test("budgetConfigFrom reads the register names createBudget's options come from", () => {
    expect(sampling.BUDGET_PARAMETERS).toEqual({
      writeBudgetPerMinute: "observability.tier_b_write_budget",
      reservoirSize: "observability.tier_b_reservoir_size",
    });
    const published = configService.buildSnapshot({ version: 7 });
    expect(sampling.budgetConfigFrom(published.values)).toEqual({ writeBudgetPerMinute: 5000, reservoirSize: 100 });
    expect(sampling.budgetConfigFrom(new Map([["observability.tier_b_write_budget", "x"]]))).toEqual({});
    expect(sampling.budgetConfigFrom(null)).toEqual({});
    // Its output is always acceptable to the constructor.
    expect(() => sampling.createBudget(sampling.budgetConfigFrom(published.values))).not.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The composition: one budget, two consumers
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D3 — the writer and the flusher are handed the same budget", () => {
  afterEach(() => jest.restoreAllMocks());

  test("server.js creates ONE budget beside the rejection aggregator and gives it to both consumers", () => {
    expect(SERVER_SOURCE).not.toMatch(/perShardBudget\s*:/);
    expect(SERVER_SOURCE.match(/const tierBBudget = sampling\.createBudget\(sampling\.budgetConfigFrom\(/g)).toHaveLength(1);
    expect(SERVER_SOURCE).toMatch(/const budget = context\.tierBBudget \|\| sampling\.createBudget\(sampling\.budgetConfigFrom\(values\)\);/);
    expect(SERVER_SOURCE).toMatch(/tierBWorker\.start\(\{ prisma, budget, registry/);
  });

  test("leaderWorkers.create — that exact call, and no other — is handed the shared budget (and the aggregator)", () => {
    // Scoped to the call's own argument list. The previous regex ran on past the call's closing
    // brace and was satisfied by `startScheduledWorkers({ … tierBBudget, … })` further down, so
    // deleting the argument here went unnoticed (D3 audit, surviving defect M5).
    const calls = callsOf(SERVER_SOURCE, "leaderWorkers.create");
    expect(calls).toHaveLength(1);
    expect(topLevelEntries(calls[0].args)).not.toBeNull();
    expect(passesProperty(calls[0].args, "tierBBudget")).toBe(true);
    expect(passesProperty(calls[0].args, "rejectionAggregator")).toBe(true);
  });

  test("startScheduledWorkers — its one call site — is handed the same shared budget (and the aggregator)", () => {
    // `callsOf` also finds the declaration `function startScheduledWorkers(context)`; the call
    // site is the one whose argument is an object literal.
    const calls = callsOf(SERVER_SOURCE, "startScheduledWorkers").filter((call) => topLevelEntries(call.args) !== null);
    expect(calls).toHaveLength(1);
    expect(passesProperty(calls[0].args, "tierBBudget")).toBe(true);
    expect(passesProperty(calls[0].args, "rejectionAggregator")).toBe(true);
  });

  test("the process budget is built from the BOOT configuration's values — the exact argument, evaluated", () => {
    // The previous check matched only `createBudget(sampling.budgetConfigFrom(` and so accepted
    // any argument at all — `budgetConfigFrom(null)` built a 0/0 budget and passed (M6).
    const declaration = SERVER_SOURCE.indexOf("const tierBBudget = sampling.createBudget(");
    expect(declaration).toBeGreaterThan(-1);
    const [call] = callsOf(SERVER_SOURCE.slice(declaration), "sampling.createBudget");
    const argument = call.args.replace(/\s+/g, " ").trim();
    expect(argument).toBe("sampling.budgetConfigFrom(app.locals.config && app.locals.config.values)");

    // `app.locals.config` is the boot configuration: bootstrapped (awaited) earlier in the same
    // `start()`, before this line runs.
    const start = SERVER_SOURCE.indexOf("async function start(");
    const bootstrap = SERVER_SOURCE.indexOf("app.locals.config = await configService.bootstrap(");
    const nextFunction = SERVER_SOURCE.indexOf("\nfunction ", start);
    expect(start).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(start);
    expect(declaration).toBeGreaterThan(bootstrap);
    expect(nextFunction === -1 || declaration < nextFunction).toBe(true);

    // The argument itself, evaluated against boot configurations: it yields exactly their values.
    // eslint-disable-next-line no-new-func
    const build = new Function("sampling", "app", `return sampling.createBudget(${argument});`);
    const atBoot = (bindings) => ({ locals: { config: configService.buildSnapshot({ version: 7, bindings }) } });
    expect(build(sampling, atBoot([])).counters(SHARD)).toMatchObject({ writeBudget: 5000, reservoirSize: 100 }); // the register defaults
    const published = [
      { level: "global", key: "", name: "observability.tier_b_write_budget", value: 1234 },
      { level: "global", key: "", name: "observability.tier_b_reservoir_size", value: 56 },
    ];
    expect(build(sampling, atBoot(published)).counters(SHARD)).toMatchObject({ writeBudget: 1234, reservoirSize: 56 });
  });

  function compose(context) {
    const config = configService.buildSnapshot({ version: 7 });
    const assemblyDeps = { marker: "assembly-deps" };
    jest.spyOn(coordinatorSolvePath, "create").mockReturnValue({
      ok: true,
      deps: assemblyDeps,
      context: { snapshot: () => config, expansionWallClockBudgetMs: 100 },
    });
    let started = null;
    jest.spyOn(coordinator, "start").mockImplementation((deps) => {
      started = deps;
      return { stop() {} };
    });
    expect(leaderWorkers.COMPOSERS.coordinator({ values: config.values, shardId: SHARD, instanceId: "i-1", ...context }).ok).toBe(true);
    return { started, assemblyDeps };
  }

  test("leaderWorkers injects the shared budget as the coordinator's recordBudget", () => {
    const shared = sampling.createBudget({ writeBudgetPerMinute: 2, reservoirSize: 1 });
    const { started } = compose({ tierBBudget: shared });
    expect(started.recordBudget).toBe(shared);
    expect(started.marker).toBe("assembly-deps"); // every assembly dependency still there
  });

  test("with no shared budget the assembly's deps pass through untouched (the worker's fallback applies)", () => {
    const { started, assemblyDeps } = compose({});
    expect(started).toBe(assemblyDeps);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. Exhaustion, recovery, and what the record claims
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D3 — exhaustion is explicit and never claims evidence that was not written", () => {
  test("within one window: EXEMPT up to the budget, RESERVOIR up to its size, the rest SHED and unwritten", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 2, reservoirSize: 1 });
    const result = await writeExempt({ prisma, budget, n: 6 });

    const verdicts = result.written.map((row) => row.tierB);
    expect(verdicts.filter((v) => v === "EXEMPT")).toHaveLength(2);
    expect(verdicts.filter((v) => v === "SHED").length).toBeGreaterThan(0);
    expect(result.shedCount).toBe(verdicts.filter((v) => v === "SHED").length);

    // Tier A claims a Tier B exactly where one exists — never for a shed decision.
    const written = new Set(prisma.__tables.tierBRecords.map((row) => row.decisionId));
    for (const row of prisma.__tables.decisionRecords) {
      expect(row.tierBWritten).toBe(written.has(row.decisionId));
      if (!row.tierBWritten) expect(row.tierBReason).toBeNull();
    }
    for (const entry of result.written) {
      expect(entry.tierBWritten).toBe(entry.tierB !== "SHED");
    }
    // Bounded: at most the budget, plus the reservoir size, plus one write per eviction.
    expect(prisma.__tables.tierBRecords.length).toBeLessThan(6);
    expect(budget.counters(SHARD)).toMatchObject({ spent: 2, budgetRemaining: 0, exemptOffered: 6 });
  });

  test("the next minute the budget recovers: EXEMPT writes resume", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 1, reservoirSize: 0 });
    const first = await writeExempt({ prisma, budget, n: 3, prefix: "A" });
    expect(first.written.map((row) => row.tierB)).toEqual(["EXEMPT", "SHED", "SHED"]);
    const next = await writeExempt({ prisma, budget, n: 2, decisionTimeMs: T0 + sampling.BUDGET_WINDOW_MS, prefix: "B" });
    expect(next.written.map((row) => row.tierB)).toEqual(["EXEMPT", "SHED"]);
  });

  test("the flusher drains the SAME budget: the window's shedding reaches the audit stream and the SLI, nothing is written twice", async () => {
    const prisma = fixture.memoryPrisma();
    const shared = sampling.createBudget({ writeBudgetPerMinute: 1, reservoirSize: 1 });
    const result = await writeExempt({ prisma, budget: shared, n: 5 });
    const tierBAfterRound = prisma.__tables.tierBRecords.length;

    const registry = sli.createRegistry();
    const flushed = await tierBWorker.flushOnce({ prisma, budget: shared, registry, now: () => T0 + sampling.BUDGET_WINDOW_MS }, {});

    const shedding = prisma.__tables.auditEvents.filter((row) => row.eventType === "TIER_B_SHEDDING");
    expect(shedding).toHaveLength(1);
    expect(shedding[0].payload).toMatchObject({ shed: result.shedCount, exemptOffered: 5, writtenWithinBudget: 1 });
    expect(registry.snapshot().counters[`sli.tier_b_shedding_count|{"shardId":"${SHARD}"}`]).toBe(result.shedCount);
    // RESERVOIR decisions were written at decision time; the flusher does not write them again.
    expect(prisma.__tables.tierBRecords).toHaveLength(tierBAfterRound);
    expect(flushed.flushed[0]).toMatchObject({ reservoirWritten: 0, shed: result.shedCount });
  });

  test("REPRODUCTION — a flusher draining a different budget sees nothing: the defect the shared instance removes", async () => {
    const prisma = fixture.memoryPrisma();
    await writeExempt({ prisma, budget: sampling.createBudget({ writeBudgetPerMinute: 1, reservoirSize: 0 }), n: 4 });
    const other = sampling.createBudget({});
    await tierBWorker.flushOnce({ prisma, budget: other, now: () => T0 + sampling.BUDGET_WINDOW_MS }, {});
    expect(prisma.__tables.auditEvents.filter((row) => row.eventType === "TIER_B_SHEDDING")).toHaveLength(0);
  });

  test("a Tier B write that fails is reported, never retained: Tier A stays false (the budget unit is spent)", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.decisionRecordB.create = async () => {
      throw new Error("connection reset");
    };
    const budget = sampling.createBudget({ writeBudgetPerMinute: 5, reservoirSize: 0 });
    const result = await writeExempt({ prisma, budget, n: 2 });
    expect(result.tierBCount).toBe(0);
    expect(result.tierBFailures).toHaveLength(2);
    expect(prisma.__tables.decisionRecords.every((row) => row.tierBWritten === false && row.tierBReason === null)).toBe(true);
    expect(budget.counters(SHARD).spent).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. Sampling is unchanged, and never charged to the budget
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D3 — the random sample is decided first and never charged", () => {
  test("write counts are exactly the sampled set, whatever the budget, and spend nothing", async () => {
    const LEGS = Array.from({ length: 40 }, (_, index) => `S-${index}`);
    const round = { ...exemptRound(0).round, decisions: LEGS.map((legId) => ({ legId, outcome: "NO_FEASIBLE_CANDIDATE" })) };
    const perLeg = Object.fromEntries(LEGS.map((legId) => [legId, { candidates: [], tierBInput: { candidates: [], columns: [], pruned: [] } }]));
    for (const budget of [sampling.createBudget({}), sampling.createBudget({ writeBudgetPerMinute: 5000, reservoirSize: 100 })]) {
      const prisma = fixture.memoryPrisma();
      const result = await decisionRecord.writeRound(
        { prisma },
        {
          round,
          context: { shardId: SHARD, snapshot: { snapshotId: round.roundId, pins: null, seed: "00" }, perLeg },
          budget,
          config: { sampleRate: 0.25, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30 },
          nowMs: T0,
        },
      );
      const expected = LEGS.map((legId) => decisionRecord.decisionIdFor(round.roundId, legId)).filter((id) => sampling.isSampled(id, 0.25)).sort();
      expect(prisma.__tables.tierBRecords.map((row) => row.decisionId).sort()).toEqual(expected);
      expect(result.shedCount).toBe(0);
      expect(budget.counters(SHARD).spent).toBe(0);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. The coordinator's round: shared budget, named shedding, fixed settings
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D3 — recordRound writes against the shared budget and names its shedding", () => {
  function roundResult(decisions) {
    return {
      decisionTimeMs: T0,
      regime: "SINGLETON",
      budgets: { budgetLimited: false, exceeded: [], counters: {}, wallClock: {} },
      decisions,
      columns: { generated: 0, kept: 0, pruned: 0, bestPrunedGammaMilliCU: null },
      assignments: [],
      deferrals: [],
      partitions: [],
      partitionMerges: [],
      committed: [],
      aborted: [],
      outcome: "NO_FEASIBLE_CANDIDATE",
      note: null,
      searchGapMilliCU: null,
      lpIpGapMilliCU: 0n,
    };
  }

  async function record({ budget, observability, n }) {
    const prisma = fixture.memoryPrisma();
    const { round, perLeg } = exemptRound(n);
    const events = [];
    const written = await coordinator.recordRound(
      { prisma, recordBudget: budget, record: (event, detail) => events.push({ event, detail }) },
      {
        shardId: SHARD,
        roundId: round.roundId,
        result: roundResult(round.decisions),
        storeTime: new Date(T0),
        snapshot: { snapshotId: round.roundId, pins: null, seed: "00" },
        observability: { sampleRate: 0, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30, ...observability },
        perLeg,
      },
    );
    return { prisma, written, events };
  }

  test("shedding in a round is reported by name, with the shared budget's counters", async () => {
    const shared = sampling.createBudget({ writeBudgetPerMinute: 1, reservoirSize: 0 });
    const { written, events } = await record({ budget: shared, n: 3 });
    const shed = events.find((row) => row.event === "coordinator.tier_b_shed");
    expect(shed).toBeDefined();
    expect(shed.detail.shed).toEqual(written.written.filter((row) => row.tierB === "SHED").map((row) => row.decisionId));
    expect(shed.detail.counters).toMatchObject({ writeBudget: 1, spent: 1 });
  });

  test("no shedding, no event", async () => {
    const { events } = await record({ budget: sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 0 }), n: 2 });
    expect(events.some((row) => row.event === "coordinator.tier_b_shed")).toBe(false);
  });

  test("POLICY — the settings are fixed at creation: a round pinned to a later publish does not resize the shared budget", async () => {
    // Created from the boot configuration (write budget 1), as server.js does.
    const boot = configService.buildSnapshot({ version: 7, bindings: [{ level: "global", key: "", name: "observability.tier_b_write_budget", value: 1 }] });
    const shared = sampling.createBudget(sampling.budgetConfigFrom(boot.values));
    expect(shared.counters(SHARD).writeBudget).toBe(1);

    // A later publish raises it to 100; the round's pinned observability says so (D2) …
    const republished = configService.buildSnapshot({ version: 8, bindings: [{ level: "global", key: "", name: "observability.tier_b_write_budget", value: 100 }] });
    const observability = coordinator.observabilityFrom(republished);
    expect(observability.writeBudgetPerMinute).toBe(100);

    // … and the shared budget still binds at 1 until the process restarts: one EXEMPT write,
    // then the boot reservoir (the register default, 100) takes the rest — none is EXEMPT.
    const { written } = await record({ budget: shared, observability, n: 3 });
    expect(written.written.map((row) => row.tierB)).toEqual(["EXEMPT", "RESERVOIR", "RESERVOIR"]);
    expect(shared.counters(SHARD)).toMatchObject({ writeBudget: 1, reservoirSize: 100, spent: 1 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. runRound — the production writer path — spends from the injected budget
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D3 — runRound hands the injected budget to the decision-record writer", () => {
  // The harness `p7d5DecisionEvidence.test.js` drives `runRound` with: a store answering the
  // clock and leadership reads, one queued Leg, and the round's collaborators stubbed. The
  // composition root's chain is server.js → leaderWorkers (deps.recordBudget) → coordinator.start
  // → runRound → recordRound → decisionRecord.writeRound; the links either side of runRound are
  // covered above, and this covers runRound itself. Before it, `runRound` could have replaced the
  // injected budget with its module-local fallback (`defaultRecordBudget`) and every suite still
  // passed (D3 audit, surviving defect M8): the fallback is sized from the same register values,
  // so the record looked identical — only the budget it was charged to differed.
  afterEach(() => jest.restoreAllMocks());

  const RUN_SHARD = leadership.DEFAULT_SHARD_ID;
  const NOW = new Date("2026-10-10T12:00:00.000Z");
  const CONFIG = { windowMinMs: 500, windowMaxMs: 3000, saturatedWindowMs: 10000, batchGrowthThreshold: 10, fastPathClasses: [], maxLegsPerRound: 500 };
  const LEG_ROW = "leg-row-1";

  function store() {
    const prisma = fixture.memoryPrisma();
    prisma.$queryRawUnsafe = async (sql) => {
      if (sql.includes("NOW()")) return [{ now: NOW }];
      if (sql.includes("ShardLeadership")) {
        return [{ shardId: RUN_SHARD, leadershipFence: "7", holder: "instance-1", leaseExpiry: new Date(NOW.getTime() + 60_000) }];
      }
      return [];
    };
    prisma.leg = { findMany: async () => [], updateMany: async () => ({ count: 0 }) };
    return prisma;
  }

  async function runWith(shared) {
    const prisma = store();
    await prisma.workQueue.create({
      data: {
        legId: LEG_ROW, shardId: RUN_SHARD, idempotencyKey: "k-1", purpose: "PRIMARY", slaClass: "standard",
        priority: 0, state: intake.QUEUE_STATE.QUEUED, enqueuedAt: new Date(NOW.getTime() - 1000),
      },
    });
    // No random sample (rate 0): the decision reaches Tier B only as an EXEMPT one, which is the
    // only verdict that is charged to the budget.
    const config = configService.buildSnapshot({
      version: 7,
      bindings: [{ level: "global", key: "", name: "observability.tier_b_sample_rate", value: 0 }],
    });
    const events = [];
    const writer = jest.spyOn(decisionRecord, "writeRound");
    const result = await coordinator.runRound(
      {
        prisma,
        planState: planState.create({ shardId: RUN_SHARD }),
        expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
        pricedCandidateFor: () => null,
        commit: async () => ({ committed: false }),
        // A decision-scoped degradation makes the Leg's decision exempt.
        perLegFor: () => ({ [LEG_ROW]: { candidates: [], rejectionSummary: [], degradations: DEGRADED, tierBInput: { candidates: [], columns: [], pruned: [] } } }),
        recordBudget: shared,
        record: (event, detail) => events.push({ event, detail }),
      },
      {
        shardId: RUN_SHARD, config: CONFIG, feasibleSupply: 3, nowMs: NOW.getTime(), instanceId: "instance-1", killSwitches: {},
        configSnapshot: () => config, codeVersion: "src-sha256:" + "a".repeat(64),
      },
    );
    return { prisma, result, events, writer };
  }

  test("the writer is handed THAT budget, and the exempt decision is charged to it", async () => {
    const shared = sampling.createBudget({ writeBudgetPerMinute: 1, reservoirSize: 0 });
    const { prisma, result, writer } = await runWith(shared);

    expect(result.ran).toBe(true);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0][1].budget).toBe(shared); // identity, not an equal-looking copy

    const [tierA] = prisma.__tables.decisionRecords;
    expect(tierA).toMatchObject({ legId: LEG_ROW, tierBWritten: true, tierBReason: sampling.WRITTEN_BECAUSE.EXEMPT });
    expect(prisma.__tables.tierBRecords.map((row) => row.decisionId)).toEqual([tierA.decisionId]);
    // Spent from the injected instance — a fallback budget would leave these at 0.
    expect(shared.counters(RUN_SHARD)).toMatchObject({ exemptOffered: 1, spent: 1, budgetRemaining: 0 });
  });

  test("an exhausted injected budget sheds the decision — it is not rescued by a fallback budget", async () => {
    const shared = sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 0 });
    const { prisma, events } = await runWith(shared);

    const [tierA] = prisma.__tables.decisionRecords;
    expect(tierA).toMatchObject({ legId: LEG_ROW, tierBWritten: false, tierBReason: null });
    expect(prisma.__tables.tierBRecords).toHaveLength(0);
    expect(shared.counters(RUN_SHARD)).toMatchObject({ exemptOffered: 1, spent: 0, shed: 1 });
    const shed = events.find((row) => row.event === "coordinator.tier_b_shed");
    expect(shed && shed.detail.shed).toEqual([tierA.decisionId]);
    expect(shed.detail.counters).toMatchObject({ writeBudget: 0, shed: 1 });
  });
});
