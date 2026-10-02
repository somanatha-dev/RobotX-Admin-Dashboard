"use strict";

/**
 * B1 — on a REAL PostgreSQL, the batched and concurrent reads produce exactly the rows and
 * snapshots the nested per-item reads produce. **Test-only.**
 *
 * For every agent in the database, at one decision time, it compares:
 *   · `loadAgentSnapshot` (the nested include, unchanged)          — the reference
 *   · `freshAgentSnapshotLoaderFor` (the commit path's concurrent read)
 *   · the round's prepared snapshot (`prepareRound` → `planningSnapshotFor`)
 * by both identifiers, and for every Leg, `loadLeg` against the prepared Leg; and the raw
 * `readAgentGraph` rows against the nested include's rows. The real `agentFacts` provider is
 * used, so the facts half is compared too.
 *
 * Variants are applied to throwaway clones (`--variants`): an agent with no BatteryState, an
 * agent with no class, and a newer EnergyModelParams version for a class.
 *
 * Usage:
 *   node tools/verify/b1/snapshotEquivalence.js --template <db> [--variants]
 *        [--server postgresql://pgverify@127.0.0.1:55720]
 */

const { spawnSync } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const TEMPLATE = arg("--template");
const SERVER = new URL(arg("--server", "postgresql://pgverify@127.0.0.1:55720"));
const PG_BIN = process.env.PG_BIN || "C:/Program Files/PostgreSQL/18/bin";
if (!["127.0.0.1", "localhost"].includes(SERVER.hostname) || SERVER.port === "5432" || SERVER.port === "") {
  throw new Error("snapshotEquivalence: loopback disposable cluster only");
}

const BACKEND = path.resolve(__dirname, "../../..");
const { PrismaClient } = require(path.join(BACKEND, "node_modules/@prisma/client"));
const solvePath = require(path.join(BACKEND, "src/workers/coordinatorSolvePath"));
const agentFacts = require(path.join(BACKEND, "src/services/agentFacts.service"));

const big = (k, v) => (typeof v === "bigint" ? `${v}n` : v);
const json = (v) => JSON.stringify(v, big);
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
};
const same = (a, b) => json(sortKeys(JSON.parse(json(a)))) === json(sortKeys(JSON.parse(json(b))));

const pg = (tool, ...rest) => {
  const out = spawnSync(path.join(PG_BIN, tool), ["-h", SERVER.hostname, "-p", SERVER.port, "-U", SERVER.username, ...rest], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${tool}: ${out.stderr}`);
  return out.stdout;
};

async function compare(db, label) {
  const prisma = new PrismaClient({ datasources: { db: { url: `postgresql://${SERVER.username}@127.0.0.1:${SERVER.port}/${db}` } } });
  const failures = [];
  let checked = 0;
  try {
    const shard = await prisma.agentCellPosition.findFirst({ select: { shardId: true } });
    const shardId = shard.shardId;
    const decisionTimeMs = Date.now();
    const context = {
      prisma,
      shardId,
      agentFactsFor: agentFacts.createAgentFactsProvider({ prisma, kv: null, tenantId: "b1-check" }),
      environmentFor: () => ({ ambientC: 20, packC: 22 }),
    };

    // Raw rows: the batched graph against the nested include.
    const nestedRows = await prisma.agentCellPosition.findMany({ where: { shardId }, include: solvePath.agentSnapshotInclude(), orderBy: { agentId: "asc" } });
    const batchedRows = (await solvePath.readAgentGraph(prisma, { shardId })).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
    checked += 1;
    if (!same(batchedRows, nestedRows)) failures.push("readAgentGraph rows differ from the nested include's rows");

    // The prepared round, through the real assembly's round object.
    const round = { legs: [], positions: nestedRows };
    const assembly = { round: null };
    const legRows = await prisma.workQueue.findMany({ select: { legId: true } });
    const legIds = legRows.map((row) => row.legId);
    const planning = await prepared(context, shardId, decisionTimeMs, legIds);
    assembly.round = planning.round;
    // Every reader from the one assembled context, so they share its configuration snapshot.
    const nested = solvePath.agentSnapshotLoaderFor(planning.context);
    const fresh = solvePath.freshAgentSnapshotLoaderFor(planning.context);
    const firstDiff = (a, b, at = "") => {
      if (json(a) === json(b)) return null;
      if (a && b && typeof a === "object" && typeof b === "object") {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const d = firstDiff(a[key], b[key], `${at}.${key}`);
          if (d) return d;
        }
        return null;
      }
      return `${at}: ${json(a)} vs ${json(b)}`.slice(0, 200);
    };

    for (const position of nestedRows) {
      for (const id of [position.agentId, position.agent.agentId]) {
        // eslint-disable-next-line no-await-in-loop
        const reference = await nested(id, { asOfMs: decisionTimeMs });
        // eslint-disable-next-line no-await-in-loop
        const viaFresh = await fresh(id, { asOfMs: decisionTimeMs });
        // eslint-disable-next-line no-await-in-loop
        const viaPlanning = await assembly.round.planningSnapshotFor(id, { asOfMs: decisionTimeMs });
        checked += 2;
        if (!same(viaFresh, reference)) failures.push(`fresh read differs for agent ${id} (${firstDiff(JSON.parse(json(viaFresh)), JSON.parse(json(reference)))})`);
        if (!same(viaPlanning, reference)) failures.push(`prepared snapshot differs for agent ${id} (${firstDiff(JSON.parse(json(viaPlanning)), JSON.parse(json(reference)))})`);
      }
    }
    const loadLeg = solvePath.legLoaderFor(context);
    for (const legId of legIds) {
      // eslint-disable-next-line no-await-in-loop
      const reference = await loadLeg(legId);
      const viaPlanning = assembly.round.planning.legFor(legId);
      checked += 1;
      if (!same(viaPlanning, reference)) failures.push(`prepared Leg differs for ${legId}`);
    }
    console.log(`${failures.length === 0 ? "PASS" : "FAIL"}  ${label}: ${nestedRows.length} agents, ${legIds.length} Legs, ${checked} comparisons, prepared=${planning.summary.prepared}${failures.length ? ` — ${failures.join("; ")}` : ""}`);
    return failures.length === 0 && planning.summary.prepared;
  } finally {
    await prisma.$disconnect();
  }

  async function prepared(ctx, shardId, decisionTimeMs, legIds) {
    // The real composition is not needed for the read: `create()` refuses a context with no
    // routing source, so the planning read is driven through the same exported pieces it uses.
    const { kv } = await require(path.join(BACKEND, "src/cache/kv")).initKv({ logger: { info() {}, warn() {}, error() {} } });
    const created = solvePath.create({ ...minimalContext(ctx), kv, shardId });
    if (!created.ok) throw new Error(`assembly refused: ${created.blockedBy}`);
    created.deps.planState.beginRound("b1-check");
    const summary = await created.deps.prepareRound({ shardId, roundId: "b1-check", decisionTimeMs, legIds });
    return { round: created.round, summary, context: created.context };
  }
}

/** A context `create()` accepts (TEST DOUBLES for every non-read seam); the store is real. */
function minimalContext(ctx) {
  const service = require(path.join(BACKEND, "src/engine/config/service"));
  const real = service.defaultSnapshot();
  const values = {
    "candidate.max_radius_by_sla_class": 700, "plan.service_time_prior": 60, "energy.model_residual_cv": 0.1,
    "energy.reserve_floor_wh": 50, "cost.energy.cu_per_wh": 0.5, "cost.wear.cu_per_metre": 0.001, "cost.failure.cu": 100,
    "cost.staleness.cu_per_second_age": 0.001, "cost.energy_consequence": { T1: 10, T2: 100, T3: 1000 },
    "cost.sla.cu_per_second_late": 0.01, "cost.sla.breach_penalty": 50, "lifecycle.cu_per_actuator_cycle": { LIFT: 0.1 },
    "lifecycle.cu_per_braking_event": 0.01, "lifecycle.cu_per_gradient_metre": 0.002, "lifecycle.cu_per_thermal_stress_second": 0.0001,
    "cost.battery.cu_per_equivalent_cycle": 40,
  };
  const snapshot = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    resolve: (name, c, o) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : real.resolve(name, c, o)),
    explain: (name, c, o) => ({ ...real.explain(name, c, o), ...(Object.prototype.hasOwnProperty.call(values, name) ? { value: values[name] } : {}) }),
  });
  return {
    ...ctx,
    snapshot,
    route: async () => ({ distanceM: 1, travelSeconds: 1, travelSdSeconds: 1, climbM: 0, descentM: 0, stopStartCycles: 0 }),
    travelTimeSpread: { source: "TEST DOUBLE" },
    speedMetresPerSecondFor: () => 1,
    hopTerrainSource: { source: "TEST DOUBLE" },
    timeBucket: "b1-check",
    vehicleMassKgFor: () => 60,
    returnLegEnergyWhPerMetreFor: () => 0.05,
    failureProbabilityFor: () => ({ probability: 0.01 }),
    routeHazardCuFor: () => 0,
    batteryWearInputsFor: () => ({}),
    runSerializable: async (c, fn) => fn(c),
    selectForUpdate: async () => null,
    signingKey: "b1-check",
    values: new Map(),
  };
}

(async () => {
  const runs = [[TEMPLATE, "as captured", null]];
  if (args.includes("--variants")) {
    runs.push([TEMPLATE, "an agent with no BatteryState", `DELETE FROM "BatteryState" WHERE "agentId" = (SELECT "agentId" FROM "AgentCellPosition" ORDER BY "agentId" LIMIT 1)`]);
    runs.push([TEMPLATE, "an agent with no class", `UPDATE "Agent" SET "agentClassId" = NULL WHERE id = (SELECT "agentId" FROM "AgentCellPosition" ORDER BY "agentId" DESC LIMIT 1)`]);
    runs.push([
      TEMPLATE,
      "a newer EnergyModelParams version",
      `INSERT INTO "EnergyModelParams" SELECT (jsonb_populate_record(NULL::"EnergyModelParams", to_jsonb(p) || jsonb_build_object('id', p.id || '-v2', 'modelVersion', p."modelVersion" + 1, 'betaDist', p."betaDist" * 1.5))).* FROM "EnergyModelParams" p`,
    ]);
  }
  let ok = true;
  for (const [template, label, sql] of runs) {
    const db = `b1snap_${Date.now()}`;
    pg("createdb.exe", "-T", template, db);
    try {
      if (sql) pg("psql.exe", "-v", "ON_ERROR_STOP=1", "-q", "-d", db, "-c", sql);
      // eslint-disable-next-line no-await-in-loop
      ok = (await compare(db, `${template} — ${label}`)) && ok;
    } finally {
      pg("dropdb.exe", "--if-exists", db);
    }
  }
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
