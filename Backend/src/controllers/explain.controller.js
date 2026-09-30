"use strict";

/**
 * `GET /api/explain/:decisionId` — the Explanation API (§21.3).
 *
 * ── Why this endpoint is a deliverable and not a convenience ────────────────
 * > An allocation engine makes thousands of consequential, contested decisions per hour.
 * > Customers dispute them, operators override them, safety reviews them, finance audits
 * > them, and engineers tune them. **A decision that cannot be explained after the fact
 * > cannot be defended, corrected, or improved.** Observability here is not
 * > instrumentation added to a finished system; it is part of the deliverable.
 *
 * Tenet T8 makes explainability a *functional* requirement, so this route is scoped and
 * shaped by §21.3's table rather than by what happens to be easy to serve.
 *
 * ── Every answer names its source ───────────────────────────────────────────
 * `TIER_A` (read directly) · `TIER_B` (read directly) · `RECONSTRUCTED` (recomputed by
 * deterministic replay). §21.3 requires the API to state which, "rather than presenting
 * recomputation as though it were retrieval", and the response therefore carries the
 * source on each answer *and* a `sources` roll-up, so a consumer cannot render an
 * explanation without it.
 *
 * ── Eight queries ───────────────────────────────────────────────────────────
 * `?query=` selects one; omitting it returns all of them. `why_not_agent` additionally
 * needs `?agentId=`, and is skipped rather than guessed when no agent is named.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 * It never reconstructs on the request path by re-running the engine. Reconstruction
 * needs the round's readers bound to a pinned snapshot, which is
 * `tools/replay/replayDecision.js`'s job and a background one: a synchronous re-solve
 * behind an operator's page-load would put the decision path on the request path, which
 * §3.4 separates for exactly this reason. Where an answer would need it, the response
 * says so and names the Tier B record's absence as the cause — an honest "this needs a
 * replay" beats a request that hangs during an incident.
 *
 * Read-only, like every other diagnostic surface since Phase 5. An endpoint that could
 * amend a decision record would destroy the non-repudiation the record exists for.
 */

const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const explanation = require("../engine/observability/explanation");
const tierB = require("../engine/observability/tierB");
const decisionRecord = require("../engine/observability/decisionRecord");
const { defaultSnapshot } = require("../engine/config/service");

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

/**
 * Join the realised outcome §21.3's last row needs: "Realised versus predicted timeline
 * and energy, with the deltas."
 *
 * Read from `CalibrationObservation`, which is where §21.5's loop already lands them, so
 * the operator-facing answer and the calibration SLI cannot disagree about what actually
 * happened.
 *
 * @param {object} prisma
 * @param {string} decisionId
 * @returns {Promise<object|null>}
 */
async function settlementFor(prisma, decisionId) {
  const rows = await prisma.calibrationObservation.findMany({ where: { decisionId } });
  if (!rows || rows.length === 0) return null;

  const settlement = {};
  for (const row of rows) {
    if (Number.isFinite(row.realised)) settlement[row.predictor] = row.realised;
  }
  return Object.keys(settlement).length > 0 ? settlement : null;
}

/**
 * GET /api/explain/:decisionId
 *
 * Query parameters: `query` (one of §21.3's eight), `agentId` (required by
 * `why_not_agent`).
 */
const explainDecision = asyncHandler(async (req, res) => explainByDecisionId(req, res, String(req.params.decisionId)));

/**
 * GET /api/explain/task/:taskId — P1.3.
 *
 * The same answer as `GET /api/explain/:decisionId`, for the task's **latest** production
 * decision. A decision id is `<shard>:<decisionTime>:<Leg.id>` — minted by whichever round
 * ran last — so a dashboard that holds a task cannot name one; this resolves it
 * (Task → Mission → Legs → newest `DecisionRecordA`) and hands over to the one explanation
 * path. It reads nothing new and explains nothing differently.
 *
 * 404 with `reason: "NO_DECISION_YET"` when no round has considered the task yet.
 */
const explainTask = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const taskId = String(req.params.taskId);

  const task = await prisma.task.findUnique({
    where: { taskId },
    select: { missions: { select: { legs: { select: { id: true } } } } },
  });
  if (!task) return res.status(HTTP_NOT_FOUND).json({ error: `no task "${taskId}"`, taskId, reason: "NO_SUCH_TASK" });

  const legIds = task.missions.flatMap((mission) => mission.legs.map((leg) => leg.id));
  const latest = legIds.length
    ? await prisma.decisionRecordA.findFirst({
        where: { legId: { in: legIds }, ...decisionRecord.PRODUCTION_ONLY },
        orderBy: { decisionTime: "desc" },
        select: { decisionId: true },
      })
    : null;
  if (!latest) {
    return res.status(HTTP_NOT_FOUND).json({ error: `no decision has been recorded for task "${taskId}" yet`, taskId, reason: "NO_DECISION_YET" });
  }
  return explainByDecisionId(req, res, latest.decisionId);
});

/**
 * The explanation of one decision, by id — the body both routes share.
 *
 * @param {object} req
 * @param {object} res
 * @param {string} decisionId
 */
async function explainByDecisionId(req, res, decisionId) {
  const prisma = getPrisma();

  const query = req.query.query ? String(req.query.query) : null;
  if (query !== null && !explanation.QUERIES.includes(query)) {
    return res.status(HTTP_BAD_REQUEST).json({
      error: `"${query}" is not one of §21.3's queries`,
      queries: explanation.QUERIES,
    });
  }
  if (query === explanation.QUERY.WHY_NOT_AGENT && !req.query.agentId) {
    return res.status(HTTP_BAD_REQUEST).json({ error: 'the "why not agent X" query needs an agentId' });
  }

  const row = await prisma.decisionRecordA.findFirst({
    // Production decisions only. §21.6's shadow records are decisions that were
    // "recorded and never executed"; serving one as an explanation of what the fleet
    // did would be answering a question about a world that never happened.
    where: { decisionId, ...decisionRecord.PRODUCTION_ONLY },
    include: { tierB: true, inputSnapshot: true },
  });

  if (!row) return res.status(HTTP_NOT_FOUND).json({ error: `no decision "${decisionId}"` });

  const snapshot = defaultSnapshot();
  const cuPerCurrencyUnit = snapshot.resolve("cost.cu_per_currency_unit");

  const settlement = await settlementFor(prisma, decisionId);

  const result = explanation.explain({
    row,
    tierBRow: row.tierB ? tierB.fromRow(row.tierB) : null,
    query,
    agentId: req.query.agentId ? String(req.query.agentId) : null,
    settlement,
    cuPerCurrencyUnit: Number.isFinite(cuPerCurrencyUnit) ? cuPerCurrencyUnit : null,
  });

  const bySource = result.answers.reduce((counts, answer) => {
    counts[answer.source] = (counts[answer.source] || 0) + 1;
    return counts;
  }, {});

  return res.json({
    decisionId: result.decisionId,
    legId: row.legId,
    roundId: row.roundId,
    shardId: row.shardId,
    decisionTime: row.decisionTime,

    // §21.2's retention and reconstruction state, stated up front rather than implied by
    // which answers came back thin.
    record: {
      tierARetained: true,
      tierBRetained: Boolean(row.tierB),
      tierBReason: row.tierBReason,
      samplingRate: row.samplingRate,
      samplingDraw: row.samplingDraw,
      inputSnapshotRetained: Boolean(row.inputSnapshot),
      reconstructable: Boolean(row.inputSnapshot),
      reconstructionNote: row.inputSnapshot
        ? "any answer this response marks as needing Tier B can be reconstructed byte-identically by replay " +
          "(§21.2); reconstruction runs off the request path (tools/replay/replayDecision.js)."
        : "the input snapshot has expired, so this decision is neither replayable nor reconstructable. §24.3 " +
          "makes that a defect, not a capacity signal.",
    },

    // §21.4: "Explanation API answers served by source (TIER_A / TIER_B / RECONSTRUCTED)."
    sources: bySource,
    answers: result.answers,
  });
}

/**
 * The eight queries, self-describing, so a consumer can discover the surface rather than
 * hard-code it against a document.
 */
const listQueries = asyncHandler(async (req, res) =>
  res.json({
    queries: explanation.QUERIES.map((query) => ({
      query,
      declaredSource: explanation.DECLARED_SOURCE[query],
      needsAgentId: query === explanation.QUERY.WHY_NOT_AGENT,
    })),
    sources: explanation.SOURCE,
    section: "§21.3",
  }),
);

module.exports = {
  explainDecision,
  explainTask,
  listQueries,
  settlementFor,
};
