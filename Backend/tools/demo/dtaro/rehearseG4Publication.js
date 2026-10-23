#!/usr/bin/env node
"use strict";

/**
 * **G4 publication — readiness audit and DISPOSABLE-database rehearsal.** Never a real database.
 *
 *   node tools/demo/dtaro/rehearseG4Publication.js --audit [--with-delivery]
 *       Offline readiness audit of the validated G4 proposal. No database.
 *
 *   node tools/demo/dtaro/rehearseG4Publication.js --rehearse \
 *        --database-url postgresql://…@127.0.0.1:<port>/<db> --expect-data-directory <dir>
 *       The publication sequence, end to end, in that disposable database: Zone rows → reference
 *       checks → publish → pin → verify → ROLL BACK → verify → RECOVER → verify.
 *
 *   … --demo-region      after --rehearse: one more version, G4 plus a SYNTHETIC second region
 *                        (demonstration only — region isolation needs a robot in another region)
 *   … --pin <version>    re-pin an existing version (live rollback / recovery while a server runs)
 *
 * ── What it publishes ───────────────────────────────────────────────────────
 * The PINNED version, restated exactly — every binding, kill-switch state, regime, shard, site
 * and the delivery-domain declaration — with ONE change: the 64 RNSIT cover cells take their
 * validated G4 zone (`rnsitZoneLayoutG4`, stage DECIDED, assignment digest `13be3a93…`) instead
 * of `rnsit-z1`. The tool refuses if the pinned map's RNSIT cells are not exactly the cover, if
 * the proposal's digest moved, or if any check fails.
 *
 * ── Why Zone rows come first ────────────────────────────────────────────────
 * `configService.publish` validates a map's structure, not its references: it accepts zone ids
 * no `Zone` row holds. At decision time F27 authorises an agent only in the `Zone` rows of its
 * region (`agentFacts.service`), so a map pinned before its rows exist makes every RNSIT route
 * "traverse unauthorised zones". This tool checks that reference itself and refuses to publish
 * while it fails. The rows get DEGENERATE boxes (0,0,0,0): the legacy bounding-box lookup
 * (`zoneManager.getZoneForCoordinates`, first box by name) then keeps answering `rnsit-z1`
 * exactly as today, instead of picking among four overlapping G4 boxes.
 *
 * ── Why it can only touch a throwaway cluster ──────────────────────────────
 * Three refusals, all before any write: `disposableDatabase.assertDisposableLocal` (loopback,
 * not port 5432), `environmentGuard.requireDisposableTarget` (not the canonical LOCAL database),
 * and — decisive — the server's own `SHOW data_directory` must equal `--expect-data-directory`,
 * which must lie under the OS temp directory. A URL can be mistyped; a data directory the
 * operator just initialised cannot be confused with Neon or the Docker LOCAL cluster.
 *
 * Writes nothing outside the target database. Never reads or writes the frontend preview (it
 * reads it, to check it agrees). Changes no engine module.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const h3 = require("h3-js");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "..");
const g4 = require(path.join(BACKEND_ROOT, "tools/campus/rnsitZoneLayoutG4"));
const zoneMap = require(path.join(BACKEND_ROOT, "tools/campus/rnsitZoneMap"));
const hierarchy = require(path.join(BACKEND_ROOT, "src/engine/spatial/hierarchy"));
const validators = require(path.join(BACKEND_ROOT, "src/engine/config/validators"));
const cells = require(path.join(BACKEND_ROOT, "src/engine/spatial/cells"));

/** The validated G4 assignment under review (RNSIT_ZONE_LAYOUT_G4_PROPOSAL.md). A moved digest is a different proposal. */
const VALIDATED_DIGEST = "13be3a93ec62ebea6e7843e9c0230f2e3fe412a0235845faac33939929145d39";
const G4_ZONE_IDS = Object.freeze(["rnsit-z-west", "rnsit-z-east", "rnsit-z-south", "rnsit-z-southwest"]);
const PREVIOUS_ZONE_ID = "rnsit-z1";
/** Degenerate: never matched by the legacy bounding-box lookup (see the header). */
const ZONE_BOX = Object.freeze({ minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 });
const PUBLISHED_BY = "tools/demo/dtaro/rehearseG4Publication.js";
const PREVIEW_MODULE = path.resolve(BACKEND_ROOT, "..", "Frontend", "src", "features", "maps", "dtaro", "rnsitZoneProposalPreview.js");

class RehearsalRefused extends Error {}

// ── The proposal ─────────────────────────────────────────────────────────────

/** The validated G4 proposal, or a refusal naming what moved. */
function loadValidated() {
  const context = g4.loadContext();
  const proposal = g4.buildProposal({ context });
  const validation = g4.validateLayout(proposal, context);
  const digest = g4.assignmentDigest(proposal);
  const problems = [];
  if (proposal.stage !== g4.STAGE.DECIDED) problems.push(`stage ${proposal.stage}, not DECIDED`);
  if (proposal.unresolved.length !== 0) problems.push(`${proposal.unresolved.length} cells unresolved`);
  if (digest !== VALIDATED_DIGEST) problems.push(`assignment digest ${digest.slice(0, 12)}… is not the validated ${VALIDATED_DIGEST.slice(0, 12)}…`);
  if (!validation.passed) problems.push(`validateLayout failed: ${validation.checks.filter((c) => !c.passed).map((c) => c.id).join(", ")}`);
  if (JSON.stringify(proposal.zones.map((z) => z.id)) !== JSON.stringify(G4_ZONE_IDS)) problems.push(`zones ${proposal.zones.map((z) => z.id).join(",")}`);
  if (problems.length) throw new RehearsalRefused(`the G4 proposal is not the validated one: ${problems.join("; ")}`);
  return { context, proposal, validation, digest };
}

/** The dashboard's read-only preview module, parsed (it is generated JSON in an ES module). */
function readPreview(file = PREVIEW_MODULE) {
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf("Object.freeze(");
  const end = text.lastIndexOf(");");
  if (start === -1 || end === -1) throw new Error(`${file} is not the generated preview module`);
  return JSON.parse(text.slice(start + "Object.freeze(".length, end));
}

/** The four `Zone` rows G4 needs, for one database's RNSIT `Region.id`. */
function zoneRowPlan(proposal, rnsitRowId) {
  return proposal.zones.map((zone) => ({ id: zone.id, name: zone.name, regionId: rnsitRowId, ...ZONE_BOX }));
}

/**
 * The pinned spatial map with the RNSIT cover reassigned to G4 — and nothing else changed.
 * Refuses unless the pinned map's RNSIT cells are exactly the 64-cell cover.
 */
function g4SpatialFrom(pinnedSpatial, { proposal, rnsitRowId }) {
  if (!pinnedSpatial || !Array.isArray(pinnedSpatial.cells)) throw new RehearsalRefused("the pinned version has no spatial map");
  const zoneOf = new Map(proposal.cells.map((row) => [row.cellId, row.zoneId]));
  const rnsitCells = pinnedSpatial.cells.filter((c) => c.regionId === rnsitRowId);
  const ids = new Set(rnsitCells.map((c) => c.cellId));
  if (rnsitCells.length !== zoneOf.size || ![...zoneOf.keys()].every((id) => ids.has(id))) {
    throw new RehearsalRefused(`the pinned map's RNSIT cells (${rnsitCells.length}) are not exactly the ${zoneOf.size}-cell cover G4 assigns`);
  }
  const otherZones = (pinnedSpatial.zones || []).filter((z) => z.regionId !== rnsitRowId);
  return {
    ...pinnedSpatial,
    zones: [...otherZones, ...G4_ZONE_IDS.map((id) => ({ id, regionId: rnsitRowId }))],
    cells: pinnedSpatial.cells.map((c) => (c.regionId === rnsitRowId ? { ...c, zoneId: zoneOf.get(c.cellId) } : c)),
  };
}

/** What changed between two spatial maps, cell by cell and part by part. */
function spatialDiff(before, after) {
  const prior = new Map(before.cells.map((c) => [c.cellId, c]));
  const changedCells = after.cells.filter((c) => {
    const p = prior.get(c.cellId);
    return !p || p.zoneId !== c.zoneId || p.regionId !== c.regionId || p.resolution !== c.resolution;
  });
  return {
    cellsBefore: before.cells.length,
    cellsAfter: after.cells.length,
    cellsWithNewZone: changedCells.length,
    cellsOtherwiseChanged: changedCells.filter((c) => prior.get(c.cellId) && prior.get(c.cellId).regionId !== c.regionId).length,
    regionsIdentical: JSON.stringify(before.regions) === JSON.stringify(after.regions),
    sitesIdentical: JSON.stringify(before.sites) === JSON.stringify(after.sites),
    zonesBefore: before.zones.map((z) => z.id),
    zonesAfter: after.zones.map((z) => z.id),
  };
}

/** The engine's publish-time checks (`hierarchy.validateForPublish` and V8). */
function engineFindings(spatial) {
  const verdict = hierarchy.validateForPublish(spatial);
  const v8 = validators.v8SpatialContainment(hierarchy.toConfigPayload(spatial));
  return [...(verdict.ok ? [] : verdict.problems), ...v8.map((f) => f.message)];
}

/**
 * Reference check `publish` does not make: every zone the map names is a `Zone` row in the same
 * region (what F27 authorises — `agentFacts.service`: Zone rows `where: { regionId }`), and every
 * cell's zone is one the map lists.
 */
function zoneRowFindings(spatial, zoneRows) {
  // The same check the HTTP publish path runs (one implementation).
  return require(path.join(BACKEND_ROOT, "src/services/spatialZoneReferences")).zoneReferenceFindings(spatial, zoneRows);
}

/** Every cover cell's zone as ALERT DELIVERY resolves it (`dtaroZoneAlert.resolvePoint`, at the cell centre). */
function resolveCover(snapshot, cover) {
  const dtaroZoneAlert = require(path.join(BACKEND_ROOT, "src/services/dtaroZoneAlert.service"));
  const out = new Map();
  for (const cellId of cover) {
    const [lat, lon] = h3.cellToLatLng(cellId);
    const r = dtaroZoneAlert.resolvePoint(snapshot, lat, lon);
    out.set(cellId, r.ok ? r.zoneId : `UNRESOLVED:${r.reason}`);
  }
  return out;
}

const countBy = (values) => {
  const out = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
};

// ── Offline readiness audit ──────────────────────────────────────────────────

/**
 * Readiness of the validated proposal, with no database. Each check is PASS, FAIL, or LIMITATION
 * (true, known, and not a reason to refuse the rehearsal — stated so it is not discovered later).
 */
function audit({ withDelivery = false } = {}) {
  const { context, proposal, validation, digest } = loadValidated();
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });

  // 1. Assignment: 64 cells, each in exactly one of the four zones.
  const counts = countBy(proposal.cells.map((r) => r.zoneId));
  const onePerCell = new Set(proposal.cells.map((r) => r.cellId)).size === proposal.cells.length;
  add(
    "ASSIGNMENT_64_EXACTLY_ONE_ZONE",
    proposal.cells.length === 64 && onePerCell && proposal.cells.every((r) => G4_ZONE_IDS.includes(r.zoneId)) && Object.keys(counts).length === 4 ? "PASS" : "FAIL",
    `${proposal.cells.length} cells; ${G4_ZONE_IDS.map((z) => `${z} ${counts[z] || 0}`).join(", ")}; digest ${digest.slice(0, 12)}…`,
  );
  // 2. The proposal's own 13 checks.
  for (const c of validation.checks) add(`G4_${c.id}`, c.passed ? "PASS" : "FAIL", c.detail);

  // 3. Against a real-shaped published map: the engine's validators and alert-path resolution.
  const map = zoneMap.candidateSpatialMap(proposal, { regionId: "audit-region" });
  const findings = engineFindings(map);
  add("ENGINE_VALIDATORS_CANDIDATE_MAP", findings.length === 0 ? "PASS" : "FAIL", findings.length ? findings.join("; ") : "validateForPublish ok, V8 findings 0");
  const resolved = resolveCover({ spatial: map }, context.cover);
  const disagree = proposal.cells.filter((r) => resolved.get(r.cellId) !== r.zoneId);
  add("ALERT_PATH_RESOLVES_G4", disagree.length === 0 ? "PASS" : "FAIL", `dtaroZoneAlert.resolvePoint at each cell centre: ${64 - disagree.length}/64 equal to G4`);

  // 4. The dashboard's preview agrees cell by cell, and is read-only by construction.
  const preview = readPreview();
  const previewZone = new Map(preview.cells.map((c) => [c.cellId, c.zoneId]));
  const previewDisagree = proposal.cells.filter((r) => previewZone.get(r.cellId) !== r.zoneId);
  add(
    "PREVIEW_AGREES",
    preview.assignmentDigest === digest && previewDisagree.length === 0 && preview.cells.length === 64 ? "PASS" : "FAIL",
    `preview digest ${String(preview.assignmentDigest).slice(0, 12)}…, ${64 - previewDisagree.length}/64 cells equal`,
  );
  add(
    "PREVIEW_READ_ONLY",
    preview.approved === false && preview.published === false && preview.kind === "PROPOSAL_PREVIEW" ? "PASS" : "FAIL",
    `kind ${preview.kind}, approved ${preview.approved}, published ${preview.published}`,
  );

  // 5. Known limitations — stated, not hidden.
  const containment = require(path.join(BACKEND_ROOT, "tools/campus/simRouteContainmentProbe")).probe();
  add(
    "SIM_ROUTES_CONTAINED",
    "LIMITATION",
    `simulator routes (v1DemonstrationComposition.networksFrom, uncontained) leave the boundary: ${JSON.stringify({ ...containment, pairsDetail: undefined }).slice(0, 400)}`,
  );
  const decided = proposal.cells.filter((r) => r.decision);
  const low = decided.filter((r) => r.decision.confidence === "LOW");
  add(
    "LOW_CONFIDENCE_DECISIONS",
    "LIMITATION",
    `${decided.length} tie decisions (${JSON.stringify(countBy(decided.map((r) => r.decision.confidence)))}); LOW, owner review: ${low.map((r) => `${r.cellId}→${r.zoneId} (${r.decision.rule})`).join("; ")}`,
  );
  add("LEGACY_BOX_LOOKUP", "LIMITATION", "Zone rows get degenerate boxes: the legacy bounding-box zone (Robot.zoneId, alertDissemination) stays rnsit-z1; DTARO alerting reads the published map");
  add("OWNER_DECISIONS_OPEN", "LIMITATION", (proposal.outstandingOwnerDecisions || []).map((d) => (typeof d === "string" ? d : JSON.stringify(d))).join(" | ") || "none listed");

  let delivery = null;
  if (withDelivery) {
    delivery = typeof g4.crossZoneDelivery === "function" ? g4.crossZoneDelivery(proposal, context) : g4.buildReport({ context, proposal }).crossZone;
    if (delivery) {
      const policy = delivery.G4 && delivery.G4.ZONE_PLUS_ROUTE;
      add("CROSS_ZONE_POLICY_COVERAGE", policy && policy.missed === 0 ? "PASS" : "FAIL", JSON.stringify({ routes: delivery.routes, robotMoments: delivery.robotMoments, ZONE_ONLY: delivery.G4.ZONE_ONLY, ZONE_PLUS_ROUTE: policy }).slice(0, 600));
    }
  }
  return {
    digest,
    counts,
    zoneRowPlan: zoneRowPlan(proposal, "<Region.id of rnsit>"),
    checks,
    passed: checks.every((c) => c.status !== "FAIL"),
    delivery,
  };
}

// ── Disposable-database guard ────────────────────────────────────────────────

const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** The server's own data directory must be the one the operator just initialised under the temp directory. */
async function verifyDisposable(prisma, { url, expectDataDirectory }) {
  const { assertDisposableLocal } = require(path.join(BACKEND_ROOT, "tools/demo/disposableDatabase"));
  assertDisposableLocal(url, { purpose: "rehearse a G4 publication" });
  if (!expectDataDirectory) throw new RehearsalRefused("--expect-data-directory is required: the data directory of the throwaway cluster you initialised");
  const tmp = os.tmpdir();
  if (!samePath(path.resolve(expectDataDirectory), tmp) && !path.resolve(expectDataDirectory).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)) {
    throw new RehearsalRefused(`--expect-data-directory ${expectDataDirectory} is not under the temp directory ${tmp}`);
  }
  const rows = await prisma.$queryRawUnsafe("SHOW data_directory");
  const actual = rows && rows[0] && rows[0].data_directory;
  if (!actual || !samePath(actual, expectDataDirectory)) {
    throw new RehearsalRefused(`the server's data_directory is "${actual}", not ${expectDataDirectory}: this is not the throwaway cluster`);
  }
  const [{ current_database: database }] = await prisma.$queryRawUnsafe("SELECT current_database()");
  return { dataDirectory: actual, database };
}

// ── The rehearsal ────────────────────────────────────────────────────────────

async function pinnedRow(prisma) {
  const pin = await prisma.configActiveVersion.findFirst();
  if (!pin) throw new RehearsalRefused("nothing is pinned: run seedV1Demonstration.js first");
  const row = await prisma.configVersion.findUnique({ where: { version: pin.version } });
  return { pin, row };
}

/** Pin `version` and read back what alert delivery would resolve for every cover cell. */
async function pinAndRead(prisma, version, cover, by) {
  const configService = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
  const started = Date.now();
  await configService.pinVersion(prisma, null, version, by);
  const snapshot = await configService.loadPinnedSnapshot({ prisma });
  const tookMs = Date.now() - started;
  const resolved = resolveCover(snapshot, cover);
  return { pinned: snapshot.version, tookMs, signature: snapshot.signature, zones: countBy([...resolved.values()]), resolved };
}

async function rehearse(prisma, { url, expectDataDirectory, log = console.log } = {}) {
  const configService = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
  const steps = [];
  const step = (id, status, detail) => {
    steps.push({ id, status, detail });
    log(`${status.padEnd(4)} ${id}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  };

  const target = await verifyDisposable(prisma, { url, expectDataDirectory });
  step("R0_DISPOSABLE_TARGET", "PASS", `data_directory ${target.dataDirectory} (as expected), database ${target.database}`);

  const { proposal, context, digest } = loadValidated();
  const cover = context.cover;
  const rnsit = await prisma.region.findUnique({ where: { regionId: "rnsit" } });
  if (!rnsit) throw new RehearsalRefused("no rnsit Region row: run seedV1Demonstration.js first");

  // R1 — what is in force before.
  const before = await pinnedRow(prisma);
  const previous = before.pin.version;
  const prevResolved = resolveCover({ spatial: before.row.payload.spatial }, cover);
  const prevZones = countBy([...prevResolved.values()]);
  const versionsBefore = await prisma.configVersion.count();
  const zoneRowsBefore = await prisma.zone.findMany({ orderBy: { id: "asc" } });
  step("R1_STATE_BEFORE", prevZones[PREVIOUS_ZONE_ID] === 64 ? "PASS" : "FAIL", { pinned: previous, versions: versionsBefore, coverResolvesTo: prevZones, zoneRows: zoneRowsBefore.map((z) => z.id) });
  if (prevZones[PREVIOUS_ZONE_ID] !== 64) throw new RehearsalRefused("the pinned map is not the one-zone RNSIT world this rehearsal starts from");

  // R2 — the candidate: the pinned version, RNSIT cells reassigned to G4, nothing else.
  const spatial = g4SpatialFrom(before.row.payload.spatial, { proposal, rnsitRowId: rnsit.id });
  const diff = spatialDiff(before.row.payload.spatial, spatial);
  const findings = engineFindings(spatial);
  const diffOk = diff.cellsWithNewZone === 64 && diff.cellsOtherwiseChanged === 0 && diff.regionsIdentical && diff.sitesIdentical && diff.cellsBefore === diff.cellsAfter;
  step("R2_CANDIDATE_BUILT", findings.length === 0 && diffOk ? "PASS" : "FAIL", { engineFindings: findings, diff, digest: `${digest.slice(0, 12)}…` });
  if (findings.length || !diffOk) throw new RehearsalRefused("the candidate map is not publishable or changes more than the RNSIT zone assignment");

  // R3 — the reference check publish does not make. Before the rows exist it MUST fail.
  const missing = zoneRowFindings(spatial, zoneRowsBefore);
  const expectedMissing = G4_ZONE_IDS.filter((id) => !zoneRowsBefore.some((z) => z.id === id));
  step("R3_PREFLIGHT_BLOCKS_WITHOUT_ZONE_ROWS", missing.length === expectedMissing.length && missing.length > 0 ? "PASS" : "FAIL", { findings: missing, note: "configService.publish would accept this map; the preflight refuses it" });

  // R4 — Zone rows first.
  const plan = zoneRowPlan(proposal, rnsit.id);
  for (const row of plan) {
    const existing = await prisma.zone.findUnique({ where: { id: row.id } });
    if (existing && (existing.regionId !== row.regionId || existing.name !== row.name)) throw new RehearsalRefused(`a Zone row "${row.id}" already exists with another region or name`);
    if (!existing) await prisma.zone.create({ data: row });
  }
  const zoneRowsAfter = await prisma.zone.findMany({ orderBy: { id: "asc" } });
  const remaining = zoneRowFindings(spatial, zoneRowsAfter);
  const authorised = (await prisma.zone.findMany({ where: { regionId: rnsit.id }, select: { id: true } })).map((z) => z.id).sort();
  step("R4_ZONE_ROWS_CREATED", remaining.length === 0 && G4_ZONE_IDS.every((id) => authorised.includes(id)) ? "PASS" : "FAIL", { created: plan.map((r) => `${r.id} "${r.name}"`), referenceFindings: remaining, f27AuthorisedInRnsit: authorised });
  if (remaining.length) throw new RehearsalRefused(`zone references still fail: ${remaining.join("; ")}`);

  // R5 — publish (a new immutable version); the pin does not move.
  const payload = before.row.payload;
  const published = await configService.publish(prisma, {
    publishedBy: PUBLISHED_BY,
    bindings: payload.bindings || [],
    killSwitchState: payload.killSwitchState,
    regimes: payload.regimes || [],
    spatial,
    deliveryDomain: payload.deliveryDomain || null,
    shards: payload.shards || null,
    note: `G4 PUBLICATION REHEARSAL on a DISPOSABLE cluster (${target.dataDirectory}). Version ${previous} restated with the 64 RNSIT cells reassigned to the validated G4 zones (digest ${digest.slice(0, 12)}…). NOT PRODUCTION.`,
  });
  const pinAfterPublish = (await prisma.configActiveVersion.findFirst()).version;
  const newRow = await prisma.configVersion.findUnique({ where: { version: published.version } });
  const valuesEqual = JSON.stringify(newRow.payload.values) === JSON.stringify(payload.values);
  const restated = ["bindings", "killSwitchState", "regimes", "deliveryDomain", "shards"].filter((k) => JSON.stringify(newRow.payload[k]) !== JSON.stringify(payload[k]));
  step(
    "R5_PUBLISHED_NOT_PINNED",
    pinAfterPublish === previous && valuesEqual && restated.length === 0 && newRow.safetyClassChanges.length === 0 ? "PASS" : "FAIL",
    { version: published.version, pinStill: pinAfterPublish, parameterValuesIdentical: valuesEqual, otherPartsDiffering: restated, safetyClassChanges: newRow.safetyClassChanges, signature: `${newRow.signature.slice(0, 16)}…` },
  );

  // R6 — pin and verify through the alert path.
  const pinned = await pinAndRead(prisma, published.version, cover, `${PUBLISHED_BY} (pin)`);
  const g4Agree = proposal.cells.every((r) => pinned.resolved.get(r.cellId) === r.zoneId);
  step("R6_PINNED_AND_RESOLVED", pinned.pinned === published.version && g4Agree ? "PASS" : "FAIL", { pinned: pinned.pinned, coverResolvesTo: pinned.zones, equalsG4: g4Agree, tookMs: pinned.tookMs });

  // R7 — ROLL BACK: re-pin the previous version. Versions are immutable and append-only.
  const rolledBack = await pinAndRead(prisma, previous, cover, `${PUBLISHED_BY} (rollback)`);
  const versionsAfterRollback = await prisma.configVersion.count();
  const stillThere = await prisma.configVersion.findUnique({ where: { version: published.version } });
  step(
    "R7_ROLLBACK",
    rolledBack.pinned === previous && rolledBack.zones[PREVIOUS_ZONE_ID] === 64 && stillThere && stillThere.signature === newRow.signature ? "PASS" : "FAIL",
    { pinned: rolledBack.pinned, coverResolvesTo: rolledBack.zones, tookMs: rolledBack.tookMs, versions: versionsAfterRollback, g4VersionKeptUnchanged: Boolean(stillThere && stillThere.signature === newRow.signature), zoneRowsKept: "inert under the previous map: no cell names them; the legacy box lookup never matches their degenerate boxes" },
  );

  // R8 — RECOVER: re-pin G4.
  const recovered = await pinAndRead(prisma, published.version, cover, `${PUBLISHED_BY} (recovery)`);
  const recoveredAgree = proposal.cells.every((r) => recovered.resolved.get(r.cellId) === r.zoneId);
  step("R8_RECOVERY", recovered.pinned === published.version && recoveredAgree && recovered.signature === newRow.signature ? "PASS" : "FAIL", { pinned: recovered.pinned, coverResolvesTo: recovered.zones, equalsG4: recoveredAgree, tookMs: recovered.tookMs });

  // R9 — the same publish request with an unknown zone in it is still accepted by publish: the
  // preflight is the only guard. Shown WITHOUT writing (zoneRowFindings on a mutated copy).
  const broken = { ...spatial, zones: [...spatial.zones, { id: "rnsit-z-unknown", regionId: rnsit.id }], cells: spatial.cells.map((c, i) => (i === 0 ? { ...c, zoneId: "rnsit-z-unknown" } : c)) };
  step("R9_PREFLIGHT_CATCHES_UNKNOWN_ZONE", zoneRowFindings(broken, zoneRowsAfter).length > 0 && engineFindings(broken).length === 0 ? "PASS" : "FAIL", {
    engineFindings: engineFindings(broken),
    preflightFindings: zoneRowFindings(broken, zoneRowsAfter),
    meaning: "the engine's validators accept a zone with no Zone row; only this preflight refuses it",
  });

  return { target, previous, published: published.version, steps, passed: steps.every((s) => s.status === "PASS") };
}

/** DEMONSTRATION ONLY: G4 plus a synthetic second region, so region isolation can be shown with a real robot. */
async function stageDemoRegion(prisma, { url, expectDataDirectory, log = console.log } = {}) {
  const configService = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
  const { R2 } = require("./stageCrossZoneDemo");
  const target = await verifyDisposable(prisma, { url, expectDataDirectory });
  const { context } = loadValidated();
  const { row } = await pinnedRow(prisma);
  const rnsit = await prisma.region.findUnique({ where: { regionId: "rnsit" } });
  const g4Resolved = resolveCover({ spatial: row.payload.spatial }, context.cover);
  if (!G4_ZONE_IDS.every((z) => [...g4Resolved.values()].includes(z))) throw new RehearsalRefused("G4 is not pinned: run --rehearse first");

  const r2 = await prisma.region.upsert({ where: { regionId: R2.regionId }, update: {}, create: { regionId: R2.regionId, name: R2.name, description: "DTARO G4 rehearsal: region-isolation demonstration only (disposable database)." } });
  await prisma.zone.upsert({ where: { id: R2.zone.id }, update: { name: R2.zone.name, regionId: r2.id }, create: { id: R2.zone.id, name: R2.zone.name, regionId: r2.id, ...ZONE_BOX } });
  const r2Cells = h3.gridDisk(cells.cellForPoint(R2.centre.lat, R2.centre.lon, cells.RESOLUTION.FINE), R2.k);
  const spatial = {
    ...row.payload.spatial,
    regions: [...row.payload.spatial.regions, { id: r2.id }],
    zones: [...row.payload.spatial.zones, { id: R2.zone.id, regionId: r2.id }],
    cells: [...row.payload.spatial.cells, ...cells.canonicalCellOrder(r2Cells).map((cellId) => ({ cellId, resolution: "FINE", regionId: r2.id, zoneId: R2.zone.id }))],
  };
  const findings = [...engineFindings(spatial), ...zoneRowFindings(spatial, await prisma.zone.findMany())];
  if (findings.length) throw new RehearsalRefused(`demonstration map refused: ${findings.join("; ")}`);
  const published = await configService.publish(prisma, {
    publishedBy: `${PUBLISHED_BY} (demo region)`,
    bindings: row.payload.bindings || [],
    killSwitchState: row.payload.killSwitchState,
    regimes: row.payload.regimes || [],
    spatial,
    deliveryDomain: row.payload.deliveryDomain || null,
    shards: row.payload.shards || null,
    note: `DEMONSTRATION ONLY on a DISPOSABLE cluster (${target.dataDirectory}): the G4 version ${row.version} plus a SYNTHETIC second region (${R2.regionId}) for region-isolation evidence. NOT PRODUCTION.`,
  });
  const after = await pinAndRead(prisma, published.version, context.cover, `${PUBLISHED_BY} (demo region pin)`);
  const rnsitIdentical = JSON.stringify(spatial.cells.filter((c) => c.regionId === rnsit.id)) === JSON.stringify(row.payload.spatial.cells.filter((c) => c.regionId === rnsit.id));
  // The dashboard selects campuses from Campus rows; the seed creates none (as stageCrossZoneDemo).
  const centre = h3.cellToLatLng(context.cover[0]);
  await prisma.campus.upsert({ where: { code: "RNSIT" }, update: { regionId: rnsit.id }, create: { code: "RNSIT", name: "RNSIT", centerLat: centre[0], centerLon: centre[1], regionId: rnsit.id } });
  log(`demo region: version ${published.version} pinned (G4 version ${row.version} + ${R2.regionId}, ${r2Cells.length} cells); RNSIT part identical: ${rnsitIdentical}; cover resolves ${JSON.stringify(after.zones)}`);
  return { version: published.version, g4Version: row.version, rnsitIdentical, coverResolvesTo: after.zones };
}

module.exports = {
  VALIDATED_DIGEST,
  G4_ZONE_IDS,
  ZONE_BOX,
  RehearsalRefused,
  loadValidated,
  readPreview,
  zoneRowPlan,
  g4SpatialFrom,
  spatialDiff,
  engineFindings,
  zoneRowFindings,
  resolveCover,
  audit,
  verifyDisposable,
  rehearse,
  stageDemoRegion,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1];
  };
  const done = (code) => process.exit(code);
  if (argv.includes("--audit")) {
    const result = audit({ withDelivery: argv.includes("--with-delivery") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    done(result.passed ? 0 : 1);
  } else {
    const url = flag("--database-url");
    const expectDataDirectory = flag("--expect-data-directory");
    if (!url || !expectDataDirectory || !(argv.includes("--rehearse") || argv.includes("--demo-region") || flag("--pin"))) {
      process.stderr.write("usage: --audit [--with-delivery] | (--rehearse | --demo-region | --pin <version>) --database-url <disposable loopback url> --expect-data-directory <its data directory>\n");
      done(2);
    }
    process.env.DATABASE_URL = url;
    const { requireDisposableTarget } = require(path.join(BACKEND_ROOT, "src/config/environmentGuard"));
    if (!requireDisposableTarget()) done(78);
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    const run = async () => {
      if (argv.includes("--rehearse")) {
        const result = await rehearse(prisma, { url, expectDataDirectory });
        process.stdout.write(`${JSON.stringify({ previous: result.previous, published: result.published, passed: result.passed }, null, 2)}\n`);
        if (!result.passed) throw new Error("one or more rehearsal steps failed");
      }
      if (argv.includes("--demo-region")) await stageDemoRegion(prisma, { url, expectDataDirectory });
      if (flag("--pin")) {
        await verifyDisposable(prisma, { url, expectDataDirectory });
        const { context } = loadValidated();
        const r = await pinAndRead(prisma, Number(flag("--pin")), context.cover, `${PUBLISHED_BY} (--pin)`);
        process.stdout.write(`${JSON.stringify({ pinned: r.pinned, tookMs: r.tookMs, coverResolvesTo: r.zones })}\n`);
      }
    };
    run()
      .then(() => prisma.$disconnect().then(() => done(0)))
      .catch(async (error) => {
        process.stderr.write(`${error instanceof RehearsalRefused ? "REFUSED" : "FAILED"}: ${error.message}\n`);
        await prisma.$disconnect();
        done(1);
      });
  }
}
