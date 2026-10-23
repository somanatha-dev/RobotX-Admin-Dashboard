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
const { publishedZoneView } = require("../services/dtaroZoneView.service");

const getZones = asyncHandler(async (req, res) => {
  const view = await publishedZoneView({
    snapshot: req.app?.locals?.config || null,
    prisma: getPrisma(),
    alertsEnabled: dtaroZoneAlert.isEnabled(),
  });
  res.set("Cache-Control", "no-store");
  res.json(view);
});

/**
 * `GET /api/dtaro/activity` — the DTARO dashboard events this process has emitted, oldest first,
 * exactly as emitted (`dtaroZoneAlert.recentActivity`). Lets a dashboard that opens or reconnects
 * after a report show it, with its recipients, decisions and verdicts. In-process and bounded:
 * a restart empties it.
 */
const getActivity = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ alertsEnabled: dtaroZoneAlert.isEnabled(), events: dtaroZoneAlert.recentActivity() });
});

module.exports = { getZones, getActivity };
