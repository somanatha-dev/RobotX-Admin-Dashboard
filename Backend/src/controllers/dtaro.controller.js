"use strict";

/**
 * `GET /api/dtaro/zones` — the published zone map for the dashboard (read-only), and
 * `GET /api/dtaro/activity` — the DTARO events already sent to the dashboard (read-only).
 *
 * SUPER_ADMIN only, like every obstacle event: campus visibility of DTARO data is an open
 * owner decision (OD-8), so the default deny stands. See `services/dtaroZoneView.service.js`.
 */

const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const dtaroZoneAlert = require("../services/dtaroZoneAlert.service");
const obstacleDecision = require("../services/dtaroObstacleDecision.service");
const { publishedZoneView } = require("../services/dtaroZoneView.service");

const getZones = asyncHandler(async (req, res) => {
  const view = await publishedZoneView({
    snapshot: req.app?.locals?.config || null,
    prisma: getPrisma(),
    alertsEnabled: dtaroZoneAlert.isEnabled(),
  });
  res.set("Cache-Control", "no-store");
  // Whether obstacle reports wait for an operator decision (the dashboard's decision panel).
  res.json({ ...view, operatorDecisionsEnabled: obstacleDecision.isEnabled() });
});

/**
 * `GET /api/dtaro/activity` — the DTARO dashboard events this process has emitted, oldest first,
 * exactly as emitted (`dtaroZoneAlert.recentActivity`). Lets a dashboard that opens or reconnects
 * after a report show it, with its recipients, decisions and verdicts. In-process and bounded:
 * a restart empties it.
 */
const getActivity = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ alertsEnabled: dtaroZoneAlert.isEnabled(), operatorDecisionsEnabled: obstacleDecision.isEnabled(), events: dtaroZoneAlert.recentActivity() });
});

/**
 * `GET /api/dtaro/decisions` — the obstacle decisions this process holds (live, with their
 * server deadline) and recent archived ones from the audit table, newest first. A dashboard that
 * reconnects restores its decision panel from this, so a countdown continues from the server's
 * deadline rather than restarting. Feature off: `{ enabled: false, decisions: [] }`, no query.
 */
const getDecisions = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!obstacleDecision.isEnabled()) {
    res.json({ enabled: false, serverNow: new Date().toISOString(), decisions: [] });
    return;
  }
  const decisions = await obstacleDecision.listDecisions(getPrisma());
  res.json({ enabled: true, serverNow: new Date().toISOString(), windowMs: obstacleDecision.DECISION_WINDOW_MS, decisions });
});

/**
 * `POST /api/dtaro/decisions/:decisionId` `{ decision, idempotencyKey }` — an operator's decision.
 * The server decides eligibility and lateness; at most one decision is ever committed, and a retry
 * with the same key and choice is answered with the committed result. Feature off: 404.
 */
const postDecision = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!obstacleDecision.isEnabled()) {
    res.status(404).json({ error: "OPERATOR_DECISIONS_DISABLED" });
    return;
  }
  const result = obstacleDecision.decide({ decisionId: req.params.decisionId, body: req.body, user: req.user });
  res.status(result.status).json(result.body);
});

module.exports = { getZones, getActivity, getDecisions, postDecision };
