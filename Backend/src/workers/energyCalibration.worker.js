"use strict";

/**
 * The κ(a) EWMA updater, run at settlement (§14.2).
 *
 * The plan names it in one line — *"κ(a) EWMA updater at settlement"* — and "at
 * settlement" is the whole of its scheduling design. There is no interval and no sweep:
 *
 * - κ is an **input** to the decision path, pinned by the round's snapshot (§9.6). A κ
 *   that moved while a round was running would make two candidates for the same agent
 *   evaluate against different models, which is a determinism failure rather than a
 *   freshness improvement.
 * - Settlement is the moment the realised energy of a completed leg becomes known, so
 *   it is the only moment at which there is anything new to fold in.
 *
 * ── Attribution ────────────────────────────────────────────────────────────
 * §16.3 states the discipline for reliability estimates — only agent-attributable
 * causes may update the estimate — and it applies here for the same reason. A mission
 * that overran because a road was closed is evidence about the route, not about the
 * drivetrain, and folding it into κ corrupts the estimate in the direction that
 * under-predicts every later mission. `consumption.updateKappa()` refuses an
 * observation explicitly marked non-attributable, and this worker passes the caller's
 * judgement straight through rather than making one.
 *
 * ── The projection-accuracy observation ────────────────────────────────────
 * §14.5 requires the realised availability of the charger each plan selected to be
 * compared at settlement against what the projection claimed, so that "a systematic
 * optimism in the projection shows up as a margin that must widen, and is alertable
 * before it shows up as a T2 event". `settleLeg()` produces that tuple alongside the κ
 * update, because settlement is the one place both facts are available together — and
 * it produces it rather than acting on it, since widening a Safety-class margin is
 * §22.4's calibration owner's decision, not a worker's.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `settleLeg()`; Phase 5's settlement path will, once
 * Phase 15 wires the engine in. This is the disposition every worker in this codebase
 * has: complete, tested, and inert behind `ENGINE_ENABLED`.
 *
 * Tier 1 by path (`src/workers/` default). Its output is Tier 0's input.
 */

const consumption = require("../engine/energy/consumption");
const eReturn = require("../engine/energy/eReturn");
const { getPrisma } = require("../db/prisma");

/**
 * Fold one settled leg's realised energy into the agent's κ, and produce the
 * charger-projection accuracy observation §14.5 asks for.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input
 * @param {string} input.agentId the `Agent.id`
 * @param {number} input.predictedWh what the model said before the mission
 * @param {number} input.realisedWh what the pack actually delivered
 * @param {number} input.alpha `energy.kappa_ewma_alpha`
 * @param {{min: number, max: number}} input.bounds `energy.kappa_bounds`
 * @param {boolean} [input.attributable]
 * @param {number} [input.socThroughput] |ΔSoC| over the leg, for §14.4's cycle count
 * @param {object} [input.chargerObservation] the realised-versus-projected tuple
 * @param {Date} [input.settledAt]
 * @returns {Promise<{ ok: boolean, kappa: number|null, previousKappa: number|null,
 *                     clamped: boolean, drift: object|null, chargerObservation: object|null,
 *                     reason: string|null }>}
 */
async function settleLeg(deps, input) {
  const prisma = (deps && deps.prisma) || getPrisma();
  const source = input || {};

  if (typeof source.agentId !== "string" || source.agentId === "") {
    return {
      ok: false,
      kappa: null,
      previousKappa: null,
      clamped: false,
      drift: null,
      chargerObservation: null,
      reason: "settleLeg names the agent whose κ it is updating",
    };
  }

  const state = await prisma.batteryState.findUnique({ where: { agentId: source.agentId } });

  // An agent with no battery-state row has no κ history. Seeding one at the class
  // default (1) is not the same as inventing an efficiency: κ = 1 means "consumes
  // exactly what the class model predicts", which is the honest prior before any
  // evidence exists.
  const previousKappa = state && Number.isFinite(state.kappa) ? state.kappa : 1;

  const updated = consumption.updateKappa(previousKappa, {
    predictedWh: source.predictedWh,
    realisedWh: source.realisedWh,
    alpha: source.alpha,
    bounds: source.bounds,
    attributable: source.attributable,
  });

  const chargerObservation = source.chargerObservation
    ? eReturn.settlementObservation({ ...source.chargerObservation, observedAt: source.settledAt || null })
    : null;

  if (!updated.ok) {
    // A refused update is not a failure of settlement. The leg still settled; the
    // observation simply was not usable evidence about this agent's efficiency, and
    // recording it anyway is what §16.3's attribution rule exists to prevent.
    return {
      ok: false,
      kappa: null,
      previousKappa,
      clamped: false,
      drift: null,
      chargerObservation,
      reason: updated.reason,
    };
  }

  const throughput = Number.isFinite(source.socThroughput) ? Math.abs(source.socThroughput) : 0;

  await prisma.batteryState.upsert({
    where: { agentId: source.agentId },
    create: {
      agentId: source.agentId,
      kappa: updated.kappa,
      kappaSampleCount: 1,
      kappaUpdatedAt: source.settledAt || new Date(),
      socThroughput: throughput,
      // @structural §14.4's own divisor: one full cycle is a discharge and a charge
      cycleCount: throughput / 2,
    },
    update: {
      kappa: updated.kappa,
      kappaSampleCount: { increment: 1 },
      kappaUpdatedAt: source.settledAt || new Date(),
      socThroughput: { increment: throughput },
      // @structural §14.4's own divisor: one full cycle is a discharge and a charge
      cycleCount: { increment: throughput / 2 },
    },
  });

  return {
    ok: true,
    kappa: updated.kappa,
    previousKappa,
    clamped: updated.clamped,
    // §14.2 — "A drifting κ is also an early maintenance indicator and is fed to §16."
    // Returned as a structured signal; §16.6's maintenance interaction is Phase 16c's,
    // and raising a work order from a settlement worker would put maintenance policy
    // in the wrong place entirely.
    drift: consumption.kappaDriftSignal(updated.kappa, source.bounds),
    chargerObservation,
    reason: null,
  };
}

module.exports = { settleLeg };
