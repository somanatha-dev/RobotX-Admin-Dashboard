const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const configService = require("../engine/config/service");
const { SCOPE_ORDER } = require("../engine/config/resolver");

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const DEFAULT_VERSION_PAGE = 50;

// Parse `?scope=region:eu-west,agent_class:porter-2` into a resolution context.
// Every key must be a §22.2 level; an unknown level is rejected rather than
// silently ignored, because a silently ignored scope returns a plausible value
// resolved at the wrong level.
function parseScope(raw) {
  const context = {};
  const unknown = [];
  if (typeof raw !== "string" || raw.trim() === "") return { context, unknown };

  for (const part of raw.split(",")) {
    const [level, ...rest] = part.split(":");
    const key = rest.join(":");
    const trimmed = (level || "").trim();
    if (!trimmed) continue;
    if (!SCOPE_ORDER.includes(trimmed)) {
      unknown.push(trimmed);
      continue;
    }
    context[trimmed] = key.trim();
  }
  return { context, unknown };
}

// Load the pinned snapshot, falling back to the register defaults when nothing has
// been published yet. Config is DB-authoritative and cache-read (§3.3).
async function currentSnapshot(req) {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv || null;
  const pinned = await configService.loadPinnedSnapshot({ prisma, kv });
  return pinned || configService.defaultSnapshot();
}

// GET /api/config/resolve?param=&scope=&index=
//
// The resolution-explain query of §22.2: "Every effective value MUST be traceable to
// the scope level that supplied it — 'why is this threshold 34?' must have a single,
// immediate answer."
const resolveParameter = asyncHandler(async (req, res) => {
  const param = typeof req.query?.param === "string" ? req.query.param.trim() : "";
  if (!param) {
    return res.status(HTTP_BAD_REQUEST).json({ ok: false, message: "query parameter `param` is required" });
  }

  const { context, unknown } = parseScope(req.query?.scope);
  if (unknown.length > 0) {
    return res.status(HTTP_BAD_REQUEST).json({
      ok: false,
      message: `unknown scope level(s): ${unknown.join(", ")}`,
      scopeLevels: SCOPE_ORDER,
    });
  }

  const snapshot = await currentSnapshot(req);
  const index = typeof req.query?.index === "string" && req.query.index.trim() ? req.query.index.trim() : undefined;
  const explanation = snapshot.explain(param, context, index ? { index } : undefined);

  if (explanation.source === configService.VALUE_SOURCE.UNKNOWN_PARAMETER) {
    return res.status(HTTP_NOT_FOUND).json({ ok: false, ...explanation });
  }

  res.json({
    ok: true,
    resolution: explanation,
    configVersion: snapshot.version,
    registerDigest: snapshot.registerDigest,
    activeRegime: snapshot.activeRegime,
    killSwitchStatus: snapshot.killSwitchClassification.status,
  });
});

// GET /api/config/versions
const listVersions = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv || null;

  const take = Number(req.query?.limit) > 0 ? Number(req.query.limit) : DEFAULT_VERSION_PAGE;
  const versions = await configService.listVersions(prisma, { take });
  const pinned = await configService.loadPinnedSnapshot({ prisma, kv });

  res.json({
    ok: true,
    activeVersion: pinned ? pinned.version : null,
    versions,
  });
});

// POST /api/config/publish
//
// Invalid configuration is rejected here, not discovered at decision time (§22.1
// rule 5). Safety-class changes additionally require two-person approval and may
// never be made by an automated process (§22.3).
const publishVersion = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv || null;
  const body = req.body || {};

  const request = {
    publishedBy: req.user?.id || req.user?.email || "unknown",
    bindings: Array.isArray(body.bindings) ? body.bindings : [],
    approvals: Array.isArray(body.approvals) ? body.approvals : [],
    killSwitchState: body.killSwitchState,
    regimes: Array.isArray(body.regimes) ? body.regimes : [],
    spatial: body.spatial,
    // S-3 row 29 (RD-2026-09-14-01 D7) — carried as its own field, never merged into
    // `spatial`. A publish that omits it publishes no delivery domain, and every geofence
    // verdict taken against that version is INDETERMINATE.
    deliveryDomain: body.deliveryDomain,
    note: typeof body.note === "string" ? body.note : null,
    // An automated caller must say so. It is then refused any Safety-class change.
    automated: Boolean(body.automated),
    enforceLaunchGate: Boolean(body.enforceLaunchGate),
  };

  let published;
  try {
    published = await configService.publish(prisma, request);
  } catch (error) {
    if (error instanceof configService.ConfigValidationError) {
      return res.status(HTTP_UNPROCESSABLE).json({ ok: false, message: error.message, findings: error.findings });
    }
    throw error;
  }

  if (body.pin !== false) {
    await configService.pinVersion(prisma, kv, published.version, request.publishedBy);
  }

  res.json({
    ok: true,
    version: published.version,
    signature: published.signature,
    publishedAt: published.publishedAt,
    pinned: body.pin !== false,
    safetyClassChanges: published.safetyClassChanges,
    launchGate: published.launchGate,
    findings: published.findings,
  });
});

module.exports = {
  parseScope,
  resolveParameter,
  listVersions,
  publishVersion,
};
