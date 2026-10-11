"use strict";

/**
 * The Tier B budget enforcer and reservoir flusher (§21.2).
 *
 * The plan names it as *"Tier B sampler + budget enforcer with reservoir fallback"*. The
 * **sampler** is not here — sampling happens at decision time, from the decision id, in
 * `observability/sampling.js`, because §21.2 requires the draw to be "seeded
 * deterministically from the decision id so that sampling is itself replayable" and a
 * decision cannot wait for a worker to learn whether it is being recorded.
 *
 * What is here is the half that genuinely needs a clock and a store:
 *
 *   1. **Draining the reservoir at each window close.** Once
 *      `observability.tier_b_write_budget` is exhausted, exempt decisions accumulate in
 *      a bottom-k reservoir in coordinator memory. The reservoir is "uniform over the
 *      exempt population", which is only true once the population is complete — so it is
 *      written at the *end* of the window, not as it fills. Writing eagerly would make
 *      the retained set "whatever arrived first", which is exactly the property §21.2
 *      says the scheme must not degrade to.
 *   2. **Recording the shedding as a counted event.**
 *      > the shedding is itself recorded as a counted event. Retention degrades visibly
 *      > and uniformly rather than by arrival order.
 *      It lands both as an SLI counter and — because it is a loss of evidence — on the
 *      hash-chained audit stream, where it cannot itself be quietly lost (§21.7).
 *   3. **Expiring Tier B past `observability.tier_b_retention`.**
 *      > Thereafter: discarded; **reconstructible by replay while the input snapshots
 *      > survive**.
 *      Which is why this worker expires Tier B and never touches `InputSnapshot`: the
 *      snapshot is what makes the discarded record recoverable, and a worker that
 *      expired both would turn a designed degradation into a permanent loss.
 *      It never touches `DecisionRecordA` either (P7-D5 D1): `tierBWritten` records that a
 *      Tier B record WAS written, and the database refuses to un-set it. Whether one is
 *      still retained is the `DecisionRecordB` row's existence — see `expireTierB`.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `start()`. Phase 15 owns production scheduling — the same
 * disposition every engine worker since Phase 4 has carried.
 *
 * Tier 1 by path (`src/workers/`).
 */

const tierB = require("../engine/observability/tierB");
const sampling = require("../engine/observability/sampling");
const auditStream = require("../engine/observability/auditStream");

/**
 * How often the reservoir is drained. One budget window, so a window's reservoir is
 * written once, complete, and never split across two flushes.
 * @structural the flusher's cadence, tied to the budget window it drains
 */
const FLUSH_INTERVAL_MS = sampling.BUDGET_WINDOW_MS;

/**
 * How many expired Tier B rows one expiry pass deletes. A bound rather than an
 * unbounded delete, so a long-idle deployment's first pass cannot take a table lock for
 * the length of its backlog.
 * @structural the expiry pass's batch size
 */
const EXPIRY_BATCH = 1000;

/**
 * Write one shard's drained reservoir, and record the shedding.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} drained a `sampling.createBudget().drain()` result
 * @param {object} context `{ retainUntil, nowMs, recordAudit }`
 * @returns {Promise<object>}
 */
async function flushReservoir(deps, drained, context) {
  const settings = context || {};
  let written = 0;

  for (const held of drained.reservoir || []) {
    if (!held.payload) continue;
    const record = tierB.build(held.payload);
    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.decisionRecordB.create({
      data: tierB.toRow(record, {
        writtenBecause: sampling.WRITTEN_BECAUSE.RESERVOIR,
        exemptionReason: (held.reasons || [])[0] ?? null,
        retainUntil: settings.retainUntil ?? null,
      }),
    });
    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.decisionRecordA.updateMany({
      where: { decisionId: held.decisionId },
      data: { tierBWritten: true, tierBReason: sampling.WRITTEN_BECAUSE.RESERVOIR },
    });
    written += 1;
  }

  if (drained.shed > 0 && settings.recordAudit !== false) {
    // A loss of evidence recorded in the one stream that is tamper-evident. A counter
    // alone would be enough to notice the shedding and not enough to prove it later,
    // which is the distinction §21.7 draws for everything else on this stream.
    await auditStream.append(deps, {
      streamId: drained.shardId,
      eventType: auditStream.EVENT_TYPE.TIER_B_SHEDDING,
      subjectType: "SHARD",
      subjectId: drained.shardId,
      reason: "observability.tier_b_write_budget exhausted; exempt Tier B records shed uniformly (§21.2)",
      payload: {
        windowStartMs: drained.windowStartMs,
        exemptOffered: drained.exemptOffered,
        writtenWithinBudget: drained.spent,
        reservoirWritten: written,
        shed: drained.shed,
      },
      recordedAtMs: settings.nowMs,
    });
  }

  return { shardId: drained.shardId, reservoirWritten: written, shed: drained.shed, spent: drained.spent };
}

/**
 * Expire Tier B records past their retention. Never touches `InputSnapshot`, and never
 * touches `DecisionRecordA`.
 *
 * ── P7-D5 D1: the retention invariant ──────────────────────────────────────
 * Tier A's `tierBWritten` / `tierBReason` say that a Tier B record WAS written, and why.
 * They are history, and `20260818120000_decision_record_immutability_scope` makes them
 * so: `tierBWritten` may go false → true and never back. Whether a Tier B record is still
 * RETAINED is the existence of its `DecisionRecordB` row, which is what every reader
 * already asks (`explain.controller` reports `tierBRetained: Boolean(row.tierB)`,
 * `replayDecision` reads `row.tierB`). So, for every decision:
 *
 *   tierBWritten = false             → never written (not sampled, shed, or the write failed)
 *   tierBWritten = true,  row exists → written and retained
 *   tierBWritten = true,  no row     → written, no longer retained; reconstructible by
 *                                      replay while the input snapshot survives (§21.2)
 *
 * This used to also run a Tier A `updateMany` un-setting `tierBWritten` after the delete,
 * as a separate statement. On PostgreSQL the trigger refuses that UPDATE, so each pass deleted
 * up to a batch of Tier B rows and then threw — leaving exactly the state it meant to
 * prevent, with no way to retry it. The delete is now the whole transition: one
 * statement, so a batch is removed entirely or not at all, and a failure leaves every
 * row as it was. A repeated pass finds nothing left that is due.
 *
 * The delete re-applies the retention test rather than trusting the rows selected a
 * moment earlier, so it can only ever remove a record that is due when it runs.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ nowMs, batch }`
 * @returns {Promise<{ expired: number, selected: number, note?: string }>} `expired` is the
 *   number of rows the delete removed; it is below `selected` only when another writer
 *   removed some of them first
 */
async function expireTierB(deps, input) {
  const source = input || {};
  const cutoff = new Date(source.nowMs);
  const due = await deps.prisma.decisionRecordB.findMany({
    where: { retainUntil: { lt: cutoff } },
    select: { id: true, decisionId: true },
    take: Number.isFinite(source.batch) ? source.batch : EXPIRY_BATCH,
  });

  if (due.length === 0) return { expired: 0, selected: 0 };

  const deleted = await deps.prisma.decisionRecordB.deleteMany({
    where: { id: { in: due.map((row) => row.id) }, retainUntil: { lt: cutoff } },
  });

  return {
    expired: deleted.count,
    selected: due.length,
    note: "Tier A is unchanged: it records that Tier B was written; reconstructible by replay while the input snapshots survive (§21.2)",
  };
}

/**
 * One pass: drain every shard's reservoir, then expire.
 *
 * @param {object} deps `{ prisma, budget, registry, now }`
 * @param {object} [context] `{ retainUntil, expiryBatch }`
 * @returns {Promise<object>}
 */
async function flushOnce(deps, context) {
  const settings = context || {};
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();

  const flushed = [];
  for (const shardId of deps.budget.shardIds()) {
    const drained = deps.budget.drain(shardId);
    if (drained.reservoir.length === 0 && drained.shed === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    flushed.push(await flushReservoir(deps, drained, { ...settings, nowMs }));

    if (deps.registry && drained.shed > 0) {
      deps.registry.count("sli.tier_b_shedding_count", drained.shed, { shardId });
    }
  }

  const expired = await expireTierB(deps, { nowMs, batch: settings.expiryBatch });

  return { nowMs, flushed, expired: expired.expired, shards: flushed.length };
}

/**
 * Start the periodic flusher.
 *
 * @param {object} deps as `flushOnce`, plus `onError`
 * @param {object} [context]
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const intervalMs = (context && context.intervalMs) || FLUSH_INTERVAL_MS;

  const handle = setInterval(() => {
    flushOnce(deps, context).catch((error) => {
      // A failed flush loses at most one window's reservoir, never a decision: Tier A is
      // already durable and the decision is reconstructible by replay.
      if (deps && typeof deps.onError === "function") deps.onError(error);
    });
  }, intervalMs);

  if (typeof handle.unref === "function") handle.unref();

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

module.exports = {
  FLUSH_INTERVAL_MS,
  EXPIRY_BATCH,
  flushReservoir,
  expireTierB,
  flushOnce,
  start,
};
