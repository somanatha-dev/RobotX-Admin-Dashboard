"use strict";

/**
 * PHASE 9 — production-reachability proof for §6's one live runtime surface.
 *
 * The Phase 8 closure's rule, applied to Phase 9: a unit-tested bound that production
 * never computes is not a verified bound. Phase 9's modules are reachable from exactly
 * one production caller today —
 *
 *     GET /api/diagnostics/candidates/:legId
 *       → diagnostics.controller.getLegCandidates
 *         → candidates/omega.combinedCorrection()
 *         → candidates/availabilityIndex.candidatesInFineCell()
 *         → candidates/lowerBound.lowerBound()
 *         → candidates/expansion.unexploredRingFloorMilliCU()
 *         → candidates/ordering.orderCandidates()
 *
 * — because `workers/coordinator.worker.js` (which would call
 * `candidates/expansion.expandCandidates`) is `LEADER_ONLY` in `workers/registry.js`
 * and nothing in this process constructs its solve path. So this harness drives the
 * reachable path end to end, through the real Express app, the real route, the real
 * auth middleware, a real PostgreSQL, and the real `kv` client — not through the
 * controller function called directly.
 *
 * Three things are proven here that no unit test reached:
 *
 *   1. **The bound resolves at all.** `omega.combinedCorrection()` returned the
 *      correction under the field name `correctionMilliCU`, while `lowerBound()` and
 *      `unexploredRingFloorMilliCU()` read `correction.milliCU` and reject anything
 *      else. Every fixture in the Phase 9 suite built the `{ milliCU }` object by hand,
 *      so the mismatch was invisible: in production the endpoint answered `lbCu: null`
 *      for every agent, and `bestLbCu`/`smallestUnexploredBoundCu`/`achievedGapCu`
 *      `null` on every request, which is §6.1's three reported quantities all absent.
 *   2. **The Ω correction is actually applied**, and not merely present — the same
 *      request against a register with a larger `cost.policy.max_total_credit` must
 *      return a strictly lower `LB`.
 *   3. **A planted violation fails closed through the production path.** With
 *      `opportunity_cost_term` live and no `omegaTerminalCu` available to this
 *      endpoint, `Ω_terminal` cannot be resolved. An `LB` missing its negative-term
 *      correction is not a lower bound (§6.4), so the endpoint must refuse rather than
 *      publish one. The violation is planted in the config register the running server
 *      reads, never by calling the guard directly.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55433/db node tools/verify/phase9ProductionPath.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "phase9-production-path-verification";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const request = require("supertest");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");

const cells = require("../../src/engine/spatial/cells");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const omega = require("../../src/engine/candidates/omega");

const PREFIX = "p9-path";
const ORIGIN = { lat: 12.9716, lon: 77.5946 };
const NEARBY = { lat: 12.9724, lon: 77.5951 };

const results = [];
function record(id, description, passed, detail) {
  results.push({ id, description, passed, detail });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${id} — ${description}`);
  if (detail) console.log(`         ${detail}`);
}

async function main() {
  const prisma = new PrismaClient();

  // The controller destructures `defaultSnapshot` at require time, so the override has
  // to be installed BEFORE the app (and therefore the controller) is first required.
  // Each scenario below then sets `snapshotOverride` to a snapshot built by the real
  // Config Service — `buildSnapshot({ bindings, killSwitchState })` — never a hand-rolled
  // stand-in, so the register's own resolution, derivation and kill-switch machinery is
  // what the endpoint reads.
  const configService = require("../../src/engine/config/service");
  const realDefaultSnapshot = configService.defaultSnapshot;
  let snapshotOverride = null;
  configService.defaultSnapshot = (...args) =>
    snapshotOverride === null ? realDefaultSnapshot(...args) : snapshotOverride;

  const bind = (name, value, level = "global", key = "") => ({ level, key, name, value });

  // `cost.energy.cu_per_wh` ships UNCALIBRATED with no default (register `cost.json`,
  // `required: true`), so on register defaults alone no CU/Wh exchange rate exists and
  // `LB` is genuinely unresolvable — the endpoint correctly says so. A deployment
  // publishes it; this harness binds it, which is the same thing through the same code.
  const PUBLISHED = [bind("cost.energy.cu_per_wh", 0.5)];

  // The app and the kv client the route will actually use.
  const app = require("../../src/app");
  const { initKv } = require("../../src/cache/kv");
  const { kv, close } = await initKv({ logger: { warn() {}, info() {}, error() {} } });
  app.locals.kv = kv;

  const created = { agentIds: [], legIds: [], missionIds: [], userIds: [], classIds: [] };
  const indexKeysWritten = [];

  /** Remove every row this harness creates. Run before and after, so a crashed run
   *  never blocks the next one. */
  async function cleanup() {
    // The Availability Index is a real Redis in this environment; clear the keys this
    // harness writes so a rerun does not inherit a previous run's agent ids.
    for (const key of indexKeysWritten) {
      const members = await kv.smembers(key).catch(() => []);
      for (const member of members) await kv.srem(key, member);
    }

    await prisma.agentCellPosition.deleteMany({ where: { agent: { agentId: { startsWith: PREFIX } } } });
    await prisma.stop.deleteMany({ where: { stopId: { startsWith: PREFIX } } });
    await prisma.leg.deleteMany({ where: { legId: { startsWith: PREFIX } } });
    await prisma.mission.deleteMany({ where: { missionId: { startsWith: PREFIX } } });
    await prisma.agent.deleteMany({ where: { agentId: { startsWith: PREFIX } } });
    await prisma.energyModelParams.deleteMany({ where: { agentClass: { classId: { startsWith: PREFIX } } } });
    await prisma.agentClass.deleteMany({ where: { classId: { startsWith: PREFIX } } });
    await prisma.energyModel.deleteMany({ where: { modelId: { startsWith: PREFIX } } });
    await prisma.mobilityModel.deleteMany({ where: { modelId: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  try {
    // The origin fine cell is fixed, so its index key can be cleared before the run too.
    indexKeysWritten.push(
      availabilityIndex.fineKey("default", cells.cellForPoint(ORIGIN.lat, ORIGIN.lon, cells.RESOLUTION.FINE), "IDLE_READY"),
    );
    await cleanup();
    console.log("\nPHASE 9 — production-path verification (real app, real route, real DB)\n");

    /* ── Fixtures ───────────────────────────────────────────────────────────── */
    const user = await prisma.user.create({
      data: { email: `${PREFIX}@verify.local`, password: "x", role: "SUPER_ADMIN" },
    });
    created.userIds.push(user.id);
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const mobilityModel = await prisma.mobilityModel.create({
      data: { modelId: `${PREFIX}-mob`, name: `${PREFIX} mobility`, traversalDomain: "GROUND", kinematicLimits: { maxSpeedMs: 2 } },
    });
    const energyModel = await prisma.energyModel.create({
      data: { modelId: `${PREFIX}-energy`, name: `${PREFIX} energy` },
    });
    const agentClass = await prisma.agentClass.create({
      data: {
        classId: `${PREFIX}-class`,
        name: `${PREFIX} class`,
        mobilityModelId: mobilityModel.id,
        energyModelId: energyModel.id,
      },
    });
    created.classIds.push(agentClass.id);

    await prisma.energyModelParams.create({
      data: { agentClassId: agentClass.id, modelVersion: 1, betaDist: 0.02, fittedAt: new Date() },
    });

    const agent = await prisma.agent.create({
      data: { agentId: `${PREFIX}-agent`, lifecycleState: "ACTIVE", agentClassId: agentClass.id },
    });
    created.agentIds.push(agent.id);

    const mission = await prisma.mission.create({ data: { missionId: `${PREFIX}-mission` } });
    created.missionIds.push(mission.id);
    const leg = await prisma.leg.create({
      data: {
        legId: `${PREFIX}-leg`,
        missionId: mission.id,
        sequence: 1,
        purpose: "PRIMARY",
        slaDeadline: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    created.legIds.push(leg.id);
    await prisma.stop.create({
      data: { stopId: `${PREFIX}-stop`, legId: leg.id, sequence: 1, stopType: "PICKUP", lat: NEARBY.lat, lon: NEARBY.lon },
    });

    const fineCellId = cells.cellForPoint(ORIGIN.lat, ORIGIN.lon, cells.RESOLUTION.FINE);
    const coarseCellId = cells.coarseParentOf(fineCellId);
    await prisma.agentCellPosition.create({
      data: {
        agentId: agent.id,
        shardId: "default",
        lat: ORIGIN.lat,
        lon: ORIGIN.lon,
        fineCellId,
        coarseCellId,
        availabilityClass: "IDLE_READY",
        capabilityClasses: [],
        containerClasses: [],
        observedAtMs: BigInt(Date.now()),
      },
    });

    // Put the agent in the live Availability Index, the way the maintainer would.
    const indexKey = availabilityIndex.fineKey("default", fineCellId, "IDLE_READY");
    indexKeysWritten.push(indexKey);
    await kv.sadd(indexKey, agent.id);

    const call = () =>
      request(app).get(`/api/diagnostics/candidates/${leg.legId}`).set("Authorization", `Bearer ${token}`);

    /* ── P9-RT-1: the route is reachable and authenticated ──────────────────── */
    const unauthenticated = await request(app).get(`/api/diagnostics/candidates/${leg.legId}`);
    record(
      "P9-RT-1",
      "the route exists and is behind authUser",
      unauthenticated.status === 401,
      `unauthenticated request → ${unauthenticated.status}`,
    );

    /* ── P9-RT-2: the search reaches the agent through the live index ───────── */
    snapshotOverride = configService.buildSnapshot({ bindings: PUBLISHED });
    const response = await call();
    const body = response.body || {};
    record(
      "P9-RT-2",
      "the live Availability Index lookup finds the seeded agent",
      response.status === 200 && body.agentsFound === 1 && Array.isArray(body.cellsExplored) && body.cellsExplored.length > 0,
      `status ${response.status}, agentsFound ${body.agentsFound}, cells ${body.cellsExplored && body.cellsExplored.length}`,
    );

    /* ── P9-RT-3: LB(a, l) actually resolves in production ──────────────────── */
    const candidate = (body.candidates || [])[0];
    record(
      "P9-RT-3",
      "LB(a, l) resolves for the agent — the Ω correction contract holds end to end",
      Boolean(candidate) && typeof candidate.lbCu === "number" && Number.isFinite(candidate.lbCu),
      candidate
        ? `lbCu=${candidate.lbCu}, unresolvedBecause=${JSON.stringify(candidate.lbUnresolvedBecause)}`
        : "no candidate row returned",
    );

    /* ── P9-RT-4: §6.1's three reported quantities are all present ──────────── */
    record(
      "P9-RT-4",
      "§6.1's diagnostic reports cells explored, smallest unexplored bound, and achieved gap",
      typeof body.bestLbCu === "number" &&
        typeof body.smallestUnexploredBoundCu === "number" &&
        typeof body.achievedGapCu === "number",
      `bestLbCu=${body.bestLbCu}, smallestUnexploredBoundCu=${body.smallestUnexploredBoundCu}, ` +
        `achievedGapCu=${body.achievedGapCu}`,
    );

    /* ── P9-RT-5: the correction is genuinely subtracted ────────────────────── */
    // Raise Ω_policy through a real config binding, and the same request must return a
    // strictly lower bound — by exactly the increase, in CU.
    const bumpCu = 500;
    const basePolicyCu = configService.buildSnapshot({ bindings: PUBLISHED }).resolve(
      "cost.policy.max_total_credit",
      {},
    );
    snapshotOverride = configService.buildSnapshot({
      bindings: [...PUBLISHED, bind("policy.max_operator_adjustment", bumpCu)],
    });
    const bumpedPolicyCu = snapshotOverride.resolve("cost.policy.max_total_credit", {});
    const bumped = await call();
    snapshotOverride = configService.buildSnapshot({ bindings: PUBLISHED });

    const before = body.bestLbCu;
    const after = bumped.body && bumped.body.bestLbCu;
    const omegaDelta = bumpedPolicyCu - basePolicyCu;
    const lbDelta = typeof before === "number" && typeof after === "number" ? before - after : null;
    record(
      "P9-RT-5",
      "raising the C_policy credit ceiling lowers LB by exactly the increase in Ω_policy",
      lbDelta !== null && omegaDelta > 0 && Math.abs(lbDelta - omegaDelta) < 1e-6,
      `Ω_policy ${basePolicyCu} → ${bumpedPolicyCu} CU (Δ ${omegaDelta}); LB ${before} → ${after} (Δ ${lbDelta})`,
    );

    /* ── P9-RT-6: planted violation — an unresolvable Ω must fail closed ────── */
    // `opportunity_cost_term` NOT thrown means C_opportunity may be negative, and this
    // endpoint has no round price snapshot to compute Ω_terminal from. §6.4 makes an LB
    // missing that correction not a lower bound, so the production path must refuse
    // rather than publish one. Planted in the config the running server reads — the
    // guard is never called directly.
    snapshotOverride = configService.buildSnapshot({
      bindings: PUBLISHED,
      killSwitchState: { opportunity_cost_term: false },
    });
    const planted = await call();
    snapshotOverride = configService.buildSnapshot({ bindings: PUBLISHED });

    const refused = planted.status === 422;
    const named = JSON.stringify(planted.body || {}).includes("omegaTerminalCu");
    record(
      "P9-RT-6",
      "PLANTED VIOLATION: with Ω_terminal unresolvable, the production path refuses instead of publishing a bound",
      refused && named,
      `status ${planted.status}; body ${JSON.stringify(planted.body).slice(0, 220)}`,
    );

    /* ── P9-RT-7: and the refusal is not a blanket failure ──────────────────── */
    const restored = await call();
    record(
      "P9-RT-7",
      "restoring the register restores a resolving bound (the refusal was the planted cause, not a broken endpoint)",
      restored.status === 200 && typeof restored.body.bestLbCu === "number",
      `status ${restored.status}, bestLbCu=${restored.body && restored.body.bestLbCu}`,
    );

    configService.defaultSnapshot = realDefaultSnapshot;

  } finally {
    await cleanup();
    await prisma.$disconnect();
    if (close) await close();
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`  FAILED: ${failed.map((result) => result.id).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
