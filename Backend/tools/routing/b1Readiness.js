"use strict";

/**
 * **B1's readiness gate** — which of the five closing steps may actually execute, and which
 * are blocked on a decision nobody in this repository is allowed to make.
 *
 * ── The defect this exists to prevent ─────────────────────────────────────
 * `b1Benchmark.js` already refuses to call an unmeasured row a pass. It has no way, however,
 * to say *why* a step cannot run, and it has only three verdicts — `PASS`, `EXCEEDED`,
 * `NOT_MEASURED` — none of which distinguishes "nobody has measured this yet" from "this
 * cannot be measured until Operations declares a region". Both exit 0, and a command that
 * exits 0 is read as a green one.
 *
 * That distinction is the whole of B1's current state. §36.8 records four of the five steps
 * BLOCKED and one COMPLETE; nothing in code says so, so nothing in code can stop a future pass
 * reporting a stub run as Step 3 evidence.
 *
 * ── The five states, and why three would not do ────────────────────────────
 *
 *   `NOT_CONFIGURED`  The input seam exists and nothing has been supplied to it. It is not a
 *                     failure and it is not a decision — it is an empty slot.
 *   `BLOCKED`         The step cannot execute, because an **external decision** (D1, D3, D8)
 *                     or a prior step's evidence is missing. No amount of engineering moves
 *                     it. This is the state B1 Steps 1, 3, 4 and 5 are in.
 *   `NOT_MEASURED`    The step *could* execute and no evidence has been recorded. Never a pass.
 *   `PASS` / `FAIL`   Evidence exists, and it does or does not meet the stated bar.
 *
 * Collapsing `BLOCKED` into `NOT_MEASURED` is how a blocker becomes a to-do; collapsing either
 * into `PASS` is how a benchmark becomes a formality.
 *
 * ── What this module decides: nothing ─────────────────────────────────────
 * It declares no region, no boundary, no bounding box, no speed model, no fleet class, no
 * extract, no vintage, no refresh cadence, no downtime budget, no threshold and no engine. It
 * reads what an operator has supplied through the one existing configuration seam
 * (`ROUTING_B1_DEPLOYMENT`, see `adapters/deployment.js`), validates it against checks the
 * architecture already states, and reports. Supplied nothing, it reports `BLOCKED` and names
 * the owner — which is the true state and the useful one.
 *
 * ── The deployment module's D1 / D3 / D8 block ────────────────────────────
 * The same file `adapters/deployment.js` documents, with three additional top-level keys that
 * are the operator's answers to the three open decisions. They sit beside the per-candidate
 * configuration because they are what a candidate is deployed *against*:
 *
 * ```js
 *   module.exports = {
 *     // D1 — Operations + Commercial. See report §36.3.1 for the five fields.
 *     region: { regionId, name, kind, boundary: { type: "Polygon", coordinates: [...] },
 *               crs: "EPSG:4326", version, versionDate },
 *     cover:  { fineCells: [{ cellId, zoneId, siteId? }], coarseCells: [...] },   // derived from it
 *     chargers: [{ chargerId, cellId }],                                          // V-12
 *
 *     // D3 — Product + Fleet Engineering. One entry per DISTINCT mobility model, not per agent
 *     // class: the FK is class -> model (schema.prisma:1123), so classes that move identically
 *     // share one model and one routing profile pair. Two entries under one modelId collide on
 *     // their routing profile key and are refused (C4).
 *     mobility: [{ modelId, traversalDomain, permissionSet, speedModel: { roadClass, gradient,
 *                  surface, payloadMass, congestion, weather }, kinematicLimits,
 *                  envelopeConstraints, dimensionalFootprint }],
 *
 *     // D8 — Operations.
 *     extract: { identity, source, vintage: "YYYY-MM-DD", refreshCadenceDays,
 *                recontractionDowntimeBudgetSeconds, bbox, marginDegrees },
 *
 *     osrm: { … }, valhalla: { … }, graphhopper: { … },
 *   };
 * ```
 *
 * Every field is the operator's. This file supplies none of them and defaults none of them.
 *
 * Usage:
 *   node tools/routing/b1Readiness.js [--json]
 * Exit 0 always: reporting that a decision is missing is not a build failure, and making it
 * one would only teach people to stop running it.
 */

const regionBoundary = require("../../src/engine/spatial/regionBoundary");
const mobilityModel = require("../../src/engine/domain/mobilityModel");
const deployment = require("./adapters/deployment");
// The engine-neutral adapter contract, for one thing only: `isPlaceholder`. It is required
// directly rather than through `./adapters`, whose index materialises every candidate against the
// environment — this module already defers that to `candidateStatus()` and must not undo it here.
const contract = require("./adapters/contract");

/**
 * @structural the five readiness states; see this file's header for why three would not do
 */
const READINESS = Object.freeze({
  NOT_CONFIGURED: "NOT_CONFIGURED",
  BLOCKED: "BLOCKED",
  NOT_MEASURED: "NOT_MEASURED",
  PASS: "PASS",
  FAIL: "FAIL",
});

/** The three open decisions B1's steps are behind, with their owners. §36.9. */
const DECISION_OWNER = Object.freeze({
  D1: "Operations + Commercial",
  D3: "Product + Fleet Engineering",
  D8: "Operations",
});

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {unknown} value @returns {boolean} */
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {string} decision
 * @param {string} status one of `READINESS`
 * @param {string[]} problems
 * @param {string} summary
 * @returns {object} frozen
 */
function verdict(decision, status, problems, summary) {
  return Object.freeze({
    decision,
    owner: DECISION_OWNER[decision] || null,
    status,
    summary,
    problems: Object.freeze([...problems]),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   D1 — the operating region
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Assess D1 against whatever the operator supplied: the declaration (V-1 … V-7), the cover
 * derived from it (V-8 … V-10), region disjointness (V-11) and charger containment (V-12).
 *
 * @param {object} config the deployment module
 * @returns {object} the verdict, plus the validated region so callers need not re-run it
 */
function assessD1(config) {
  const source = config || {};
  const declaration = regionBoundary.validateRegionDeclaration(source.region);

  if (declaration.status === regionBoundary.BOUNDARY_STATUS.NOT_CONFIGURED) {
    return Object.freeze({
      ...verdict(
        "D1",
        READINESS.BLOCKED,
        declaration.problems,
        "no authoritative operating region has been declared — the boundary B1's extract is cut from does not exist",
      ),
      region: declaration,
      cover: null,
      d2Residual: regionBoundary.d2ResidualCheck({}),
    });
  }
  if (declaration.status === regionBoundary.BOUNDARY_STATUS.INVALID) {
    // A supplied-but-invalid region is a FAIL, not a BLOCK: somebody answered, and the answer
    // is unusable. The distinction matters because the two go to different people.
    return Object.freeze({
      ...verdict("D1", READINESS.FAIL, declaration.problems, "a region was declared and it does not validate"),
      region: declaration,
      cover: null,
      d2Residual: regionBoundary.d2ResidualCheck({}),
    });
  }

  const problems = [];
  const cover = regionBoundary.validateCover(source.cover);
  if (cover.status === regionBoundary.BOUNDARY_STATUS.NOT_CONFIGURED) {
    problems.push(
      "the region validates, but no cell cover has been supplied for it. The cover is Engineering's to derive from " +
        "the boundary (report §30.4 G2/G3) and B1's cache key space, charger precompute and containment checks all " +
        "read it — so D1 is not fully released until it exists",
    );
  } else {
    problems.push(...cover.problems);
  }

  // ── V-11 — and the region under assessment is always in the comparison ──────────────────
  // PHASE 15 adversarial pass. This read `Array.isArray(source.regions) ? source.regions.map(…)
  // : [declaration]`, so the moment an operator supplied the neighbours the seam documents —
  // `regions?: [ …OTHER region declarations, for V-11 disjointness… ]` — the declaration being
  // assessed dropped out of the set. With one neighbour supplied, `validateRegionsDisjoint`
  // received a single region, and a single region cannot overlap: two regions sharing half
  // their area reported D1 PASS with zero problems. The check was called and was a no-op in
  // exactly the configuration it exists for.
  //
  // The declaration is therefore always the first member. A `regions` entry that re-declares
  // the primary's own regionId is reported as the duplicate it is rather than compared against
  // itself — §3.5 makes region → shard a function, so one id naming two declarations is
  // ill-formed input whichever geometry each carries, and reporting it is strictly the
  // fail-closed direction: both branches produce a problem, neither produces a pass.
  //
  // ── R-1 — a neighbour that does not validate is REPORTED, never dropped ──────────────────
  // PHASE 15 residual pass. `validateRegionsDisjoint` filters its argument to the entries whose
  // status is VALID, because it can only compare geometry it has; `assessD1` folded in the
  // *disjointness* problems and never the neighbours' own declaration problems. So a malformed
  // entry in `regions[]` — a three-position ring, a `[lat, lon]` swap, a missing regionId, a
  // `null`, a bare string — vanished before V-11 saw the set, and D1 reported PASS with zero
  // problems over a region collection that contained unusable data. It is the same shape as A2
  // one layer out: the check ran, over a set the bad input had already left.
  //
  // A neighbour is an operator's answer like any other, so it is validated by the same authority
  // and its problems are attributed to the slot they came from. Nothing is repaired and nothing
  // is dropped; the collection is either usable in full or it is a FAIL naming which entry is
  // not. An absent `regions` key is still an absence — the seam writes it `regions?` — but a key
  // that is present and is not an array is a wrong-typed answer rather than an absence, and §4.1
  // rule 3 forbids reading "no neighbours" out of it.
  if (source.regions !== undefined && !Array.isArray(source.regions)) {
    problems.push(
      `V-11 regions must be an array of region declarations, received ${JSON.stringify(source.regions) || String(source.regions)}. ` +
        "It carries the OTHER regions this deployment operates, for the disjointness comparison; omit the key " +
        "entirely if there are none — a value that is not an array is a wrong answer, not the absence of one, and " +
        "reading it as 'no neighbours' would switch V-11 off for exactly the deployment it exists for",
    );
  }
  const neighbours = Array.isArray(source.regions) ? source.regions.map((entry) => regionBoundary.validateRegionDeclaration(entry)) : [];
  neighbours.forEach((entry, index) => {
    if (entry.status === regionBoundary.BOUNDARY_STATUS.VALID) return;
    if (entry.status === regionBoundary.BOUNDARY_STATUS.NOT_CONFIGURED) {
      problems.push(
        `V-11 regions[${index}] is empty (null or undefined). Every entry is a region declaration to compare this ` +
          "one against; an empty slot is not one, and it cannot be compared — so it is reported rather than skipped, " +
          "because a neighbour that quietly leaves the comparison is a neighbour V-11 never checked",
      );
      return;
    }
    for (const problem of entry.problems) {
      problems.push(`V-11 regions[${index}] does not validate, so it cannot be compared for disjointness — ${problem}`);
    }
  });
  const redeclared = neighbours.filter((entry) => entry.regionId !== null && entry.regionId === declaration.regionId);
  for (const duplicate of redeclared) {
    problems.push(
      `V-11 regions[] re-declares "${duplicate.regionId}", the region under assessment. §3.5 makes region → shard a ` +
        "function (Shard.regionId is unique), so one id naming two declarations is undefined rather than redundant. " +
        "regions[] carries the OTHER regions this deployment operates, for the disjointness comparison; the region " +
        "being assessed is already in it",
    );
  }
  const disjoint = regionBoundary.validateRegionsDisjoint([declaration, ...neighbours.filter((entry) => entry.regionId !== declaration.regionId)]);
  problems.push(...disjoint.problems);

  // ── V-12 — run unconditionally, so that "no catalogue" is an absence rather than a pass ──
  // PHASE 15 adversarial pass. This was guarded by `Array.isArray(source.chargers) &&
  // source.cover`, so a deployment that supplied no charger catalogue at all — or supplied one
  // under the wrong type — skipped V-12 silently and D1 reported PASS. `chargers[]` is not
  // optional in the seam `deployment.js` and §36.3.1 document (`regions?` and
  // `cardinalityException?` carry the question mark; `chargers` does not), and §14.5 makes it
  // `E_return`'s population. The validator already answers NOT_CONFIGURED with a reason when
  // either input is missing, so folding its problems in unconditionally reports the absence
  // instead of consuming it — the same treatment the cover above already gets.
  problems.push(...regionBoundary.validateChargerContainment({ cover: source.cover, chargers: source.chargers }).problems);

  // D2's residual is **carried, not charged to D1.** The check §36.2 records as unrunnable is
  // run here for the first time — it needed D1 field 2 and a geometry, and both now exist —
  // and its answer is reported on the verdict. It is deliberately not added to D1's problem
  // list: an out-of-band cover is already V-9's finding against the cover, and whether res 8
  // stands or §6.2's per-region override is taken up is **Architecture's** call, not the
  // Operations decision D1's status is about. Conflating the two would send an Architecture
  // question back to the people who supplied a perfectly valid boundary.
  const d2Residual = regionBoundary.d2ResidualCheck({ kind: declaration.kind, fineCellCount: cover.fineCellCount });

  return Object.freeze({
    ...verdict(
      "D1",
      problems.length === 0 ? READINESS.PASS : READINESS.FAIL,
      problems,
      problems.length === 0 ? `region "${declaration.regionId}" (${declaration.kind}) validates` : `region "${declaration.regionId}" was declared and something downstream of it does not validate`,
    ),
    region: declaration,
    cover,
    d2Residual,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   D3 — the fleet's agent classes and their mobility models
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Assess D3: is there at least one agent class whose mobility model can weight a routing
 * edge? A contraction hierarchy is a precomputation over edge **costs** (§20.3 item 5), so
 * without one there is nothing to precompute over and Step 1 cannot run even where an extract
 * exists — which is why D3 blocks Step 1 independently of D1 (§36.6).
 *
 * @param {object} config the deployment module
 * @returns {object}
 */
function assessD3(config) {
  const declared = config && Array.isArray(config.mobility) ? config.mobility : null;
  if (!declared || declared.length === 0) {
    return Object.freeze({
      ...verdict(
        "D3",
        READINESS.BLOCKED,
        [
          "no fleet mobility model has been supplied. The repository's only MobilityModel is the durable seed's " +
            "MOB-SIDEWALK-DEFAULT, whose speedModel is a note deferring to this decision — a declaration, not a model. " +
            "Required: the agent classes this deployment operates and, per class, §2.2's six elements with a real " +
            `speed model over ${mobilityModel.SPEED_MODEL_FACTORS.join(", ")}`,
        ],
        "no fleet speed model exists — routing edge costs cannot be derived",
      ),
      models: Object.freeze([]),
    });
  }

  const models = declared.map((model) => {
    const readiness = mobilityModel.validateRoutingReadiness(model);
    return Object.freeze({
      modelId: model && typeof model.modelId === "string" ? model.modelId : "<unnamed>",
      profileKey: mobilityModel.routingProfileKey(model, { loaded: false }),
      routable: readiness.routable,
      speedModelStatus: readiness.speedModel.status,
      problems: Object.freeze(readiness.problems),
    });
  });

  // ── Closure criterion C4 (report §38.7): the supplied set must key COLLISION-FREE ──────
  // `routingProfileKey()` is the first component of every §20.3 cache key and it names one
  // contraction hierarchy per region, so two distinct models deriving one key would share a
  // hierarchy and share cached travel times — one model's edge costs served for the other.
  // That is the failure class `ADR-33` rider 2 names, reached from the other side: rider 2
  // guards a *broken* model keying `unknown:unknown:*`; this guards two *well-formed* models
  // keying identically, which `validateRoutingReadiness()` cannot see because it is a property
  // of the set rather than of any one model.
  //
  // §38.6.6 dismissed this on the ground that `MobilityModel.modelId` is `@unique`
  // (`schema.prisma:978`), so the durable store refuses it. That constraint never runs on this
  // path: a `ROUTING_B1_DEPLOYMENT` module is a hand-written file the durable store never sees,
  // and it is the only input this function reads. Without the check a colliding set reports
  // D3 `PASS` and releases Step 1.
  //
  // The load bit is a fixed suffix on an otherwise identical string, so two models collide
  // under `:loaded` exactly when they collide under `:unloaded`; one comparison covers both.
  // **This decides nothing** — it compares keys derived from what the operator supplied, and
  // supplies no modelId, no traversal domain and no value of its own.
  const byKey = new Map();
  for (const model of models) {
    if (!byKey.has(model.profileKey)) byKey.set(model.profileKey, []);
    byKey.get(model.profileKey).push(model.modelId);
  }
  const collisions = [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(
      ([key, ids]) =>
        `${ids.length} supplied mobility models (${ids.join(", ")}) derive the same routing profile key "${key}". ` +
        "That key is the first component of every §20.3 cache key and names one contraction hierarchy per region, " +
        "so the two would share both and one model's edge costs would be served for the other (§38.7 C4). Each " +
        "distinct locomotion behaviour needs its own modelId; classes that genuinely move identically should " +
        "share ONE model rather than be declared twice under one id",
    );

  const unroutable = models.filter((model) => !model.routable);
  const problems = [...unroutable.flatMap((model) => model.problems), ...collisions];
  return Object.freeze({
    ...verdict(
      "D3",
      problems.length === 0 ? READINESS.PASS : READINESS.FAIL,
      problems,
      problems.length === 0
        ? `${models.length} mobility model(s) declared, every one routable and distinctly keyed`
        : [
            unroutable.length > 0 ? `${unroutable.length} of ${models.length} declared mobility model(s) cannot weight a routing edge` : null,
            collisions.length > 0 ? `${collisions.length} routing profile key collision(s) across ${models.length} declared model(s)` : null,
          ]
            .filter(Boolean)
            .join("; "),
    ),
    models: Object.freeze(models),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   D8 — extract vintage, refresh cadence, re-contraction window
   ═══════════════════════════════════════════════════════════════════════════ */

/** @structural days to milliseconds */
const MS_PER_DAY = 86400000;

/**
 * Is a value the axis-aligned box V-13 compares against? Four finite numbers, and the box is
 * not inside-out. Nothing is defaulted: an absent or malformed box is the operator's to supply.
 *
 * @param {unknown} box
 * @returns {boolean}
 */
function isBoundingBox(box) {
  if (!box || typeof box !== "object") return false;
  for (const field of ["minLon", "minLat", "maxLon", "maxLat"]) {
    if (typeof box[field] !== "number" || !Number.isFinite(box[field])) return false;
  }
  return box.minLon <= box.maxLon && box.minLat <= box.maxLat;
}

/**
 * Assess D8. Three parts, and they do not all have the same blocker (§36.7): the **vintage**
 * and the **cadence** are properties of an extract and therefore behind D1; the **downtime
 * budget** is an availability question Operations can answer without knowing the region, but
 * its number cannot be fixed until the chosen engine's build time is measured at Step 4.
 *
 * `asOf` is a parameter rather than a clock read. A readiness report that changed because it
 * was run at a different minute would not be reproducible, and §9.6's determinism discipline
 * applies to a tool's own output as much as to a round's. The CLI supplies today's date; every
 * test supplies a fixed one.
 *
 * ── V-13, and F1's discharge ───────────────────────────────────────────────
 * `B1_ROUTING_ENGINE_DECISION_PREPARATION.md` §11 F1 records
 * `regionBoundary.validateExtractMargin()` as *"implemented, unit-tested, called by nothing"*,
 * and records the consequence exactly: this function validated `identity`, `source`,
 * `vintage`, `refreshCadenceDays` and `recontractionDowntimeBudgetSeconds` and **never read
 * `extract.bbox` or `extract.marginDegrees`**, so a deployment could supply an extract whose
 * bounding box does not cover the region and D8 would report `PASS`. That was reproduced
 * mechanically in this pass and is now discharged the way F1 prescribes: the two fields are
 * required like the other five, and V-13 runs against the region D1 validated.
 *
 * **No margin, box, vintage or cadence is supplied, defaulted or inferred here.** The two new
 * fields are refused when absent — which is what the other five already do — and V-13 is run,
 * never simulated: when D1 has not produced a valid region the check reports that it could not
 * run and D8 is `BLOCKED` on D1, which is the state it is already in on this tree.
 *
 * @param {object} config the deployment module
 * @param {{ asOf?: string, region?: object }} [options] an ISO date to evaluate staleness
 *   against, and the validated D1 declaration V-13 sizes the extract against
 * @returns {object}
 */
function assessD8(config, options) {
  const extract = config && config.extract;
  const asOf = options && options.asOf;
  const region = options && options.region;

  if (!extract || typeof extract !== "object") {
    return verdict(
      "D8",
      READINESS.BLOCKED,
      [
        "no extract metadata has been supplied. D8 is three decisions and none of them is recorded anywhere in " +
          "this repository: which OSM snapshot the extract is cut from (vintage), how often it is re-cut " +
          "(cadence), and what routing downtime a re-contraction may take. CellAssignment.mapVersion defaults to 0 " +
          "and is explicitly not a foreign key, so there is not even a site to record a vintage at",
      ],
      "extract vintage, refresh cadence and re-contraction budget are all undecided",
    );
  }

  const problems = [];
  if (!isNonEmptyString(extract.identity)) problems.push("extract.identity is required — a stable name for the extract every measurement will be attributed to");
  if (!isNonEmptyString(extract.source)) problems.push("extract.source is required — where the snapshot came from, so a re-cut can be reproduced");
  // ── R-3 — a placeholder is not a named source ───────────────────────────────────────────
  // PHASE 15 residual pass. These two are D8's named-evidence fields — `identity` is what every
  // Step 3 and Step 4 measurement is *attributed to*, and `source` is the answer to "where did
  // this snapshot come from, and how is it re-cut?". Both were judged by "is it a non-empty
  // string?" alone, so `source: "tbd"` reported D8 PASS: an extract with no stated provenance,
  // recorded as a complete D8 answer. The placeholder authority already existed one directory
  // away and covered four `deployment` fields for exactly this reason; it is one rule now rather
  // than two, and no value is supplied for either field here.
  for (const field of ["identity", "source"]) {
    if (isNonEmptyString(extract[field]) && contract.isPlaceholder(extract[field])) {
      problems.push(
        `extract.${field} is "${extract[field]}", which is a placeholder rather than a named answer. D8 part 1 is ` +
          "the snapshot the extract was cut from and every B1 measurement is attributed to it; a placeholder is " +
          "indistinguishable from an answer once it reaches a Step 4 record, and a re-cut cannot be reproduced from " +
          "one. Naming it is Operations'; nothing is inferred or defaulted here",
      );
    }
  }
  // The date authority is `regionBoundary.isIsoDate`, the one D1's `versionDate` is judged by.
  // PHASE 15 adversarial pass: this was a local `/^\d{4}-\d{2}-\d{2}$/` test, which accepted
  // `2026-02-31` — a string that matches the shape and is not a date. D8 then reported PASS on
  // it, having computed an age against a rolled-over month, while the same string supplied as
  // `region.versionDate` was refused two functions away. One kind of fact, two rules.
  if (!regionBoundary.isIsoDate(extract.vintage)) {
    problems.push(
      "extract.vintage is required as an ISO calendar date (YYYY-MM-DD) — D8 part 1, the OSM snapshot the extract " +
        "was cut from. It is never inferred from a file timestamp: a copied file has a new timestamp and the same " +
        "vintage",
    );
  }
  if (!Number.isInteger(extract.refreshCadenceDays) || extract.refreshCadenceDays <= 0) {
    problems.push(
      "extract.refreshCadenceDays is required — D8 part 2, how often this extract is re-cut. It trades against the " +
        "region's real rate of physical change and is Operations', not Engineering's. No cadence is chosen here",
    );
  }
  if (!isPositiveNumber(extract.recontractionDowntimeBudgetSeconds)) {
    problems.push(
      "extract.recontractionDowntimeBudgetSeconds is required — D8 part 3, the routing downtime a hierarchy rebuild " +
        "may take. §5.2 requires the routing service colocated with the shard and available throughout, and a " +
        "re-contraction is a rebuild rather than a reload. The number is Operations' to state and B1 Step 4's to " +
        "measure against; neither is done here",
    );
  }

  // ── The two fields V-13 reads, required for the same reason the other five are ──────────
  // Both are named in `deployment.js`'s extract block and in §36.3.1's, and neither was read
  // by anything. They are Operations' to state — the box the extract was actually cut to, and
  // the margin it was cut with — and no value for either is supplied or defaulted here.
  if (!isBoundingBox(extract.bbox)) {
    problems.push(
      "extract.bbox is required — { minLon, minLat, maxLon, maxLat } in the region's own CRS, the box the extract " +
        "was actually cut to. V-13 compares it against the region's bounding box plus the margin; without it the " +
        "check that the routing graph covers the region cannot run, and an extract that does not cover the region " +
        "answers every query and answers some of them wrongly",
    );
  }
  if (!isFiniteNumber(extract.marginDegrees) || extract.marginDegrees < 0) {
    problems.push(
      "extract.marginDegrees is required and must be a finite non-negative number of degrees — the margin the " +
        "extract was cut with beyond the region's own bounding box. Its size is a property of the chosen engine's " +
        "snapping and border behaviour, measured at B1 Step 1/3; none is assumed here",
    );
  }

  if (problems.length > 0) {
    return verdict("D8", READINESS.BLOCKED, problems, "extract metadata is incomplete — the missing fields are decisions, not derivations");
  }

  // ── V-13 — F1's discharge. The check exists, and this is the caller it never had ─────────
  // Every input V-13 needs from the extract is present by here, so a `NOT_CONFIGURED` answer
  // can only mean the other input is absent: D1 has not produced a valid region to size the
  // extract against. That is a blocker on D1, not a pass, and saying so is the whole point of
  // keeping BLOCKED and PASS apart.
  const margin = regionBoundary.validateExtractMargin({ region, extract });
  if (margin.status === regionBoundary.BOUNDARY_STATUS.NOT_CONFIGURED) {
    return verdict(
      "D8",
      READINESS.BLOCKED,
      [...margin.problems],
      "extract metadata is complete; V-13 cannot run without D1's region and D8 is not released without it",
    );
  }
  if (margin.status === regionBoundary.BOUNDARY_STATUS.INVALID) {
    return verdict("D8", READINESS.FAIL, [...margin.problems], "the extract does not cover the declared region plus its own stated margin");
  }

  // Every field is present. Staleness is the one thing that can now be evaluated, and only
  // against a supplied date.
  if (!isNonEmptyString(asOf)) {
    return verdict("D8", READINESS.NOT_MEASURED, ["staleness was not evaluated: no evaluation date was supplied"], "extract metadata is complete; staleness not evaluated");
  }
  const ageDays = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${extract.vintage}T00:00:00Z`)) / MS_PER_DAY);
  if (!Number.isFinite(ageDays)) {
    return verdict("D8", READINESS.NOT_MEASURED, [`staleness was not evaluated: "${asOf}" is not an ISO date`], "extract metadata is complete; staleness not evaluated");
  }
  // PHASE 15 adversarial pass — the other direction. `ageDays > cadence` is the only
  // comparison this made, so a vintage dated **after** the evaluation date produced a negative
  // age, cleared any cadence, and reported PASS: a single mistyped year pinned the extract
  // permanently fresh, and the staleness check that exists because *"a stale extract routes
  // over a map the region no longer has, and it does so silently"* would never fire again.
  // A snapshot cannot be cut from a map that does not exist yet, so this is a FAIL rather than
  // a stale one — and no date is corrected here.
  if (ageDays < 0) {
    return verdict(
      "D8",
      READINESS.FAIL,
      [
        `the extract's vintage ${extract.vintage} is ${-ageDays} days AFTER the evaluation date ${asOf}. An OSM ` +
          "snapshot cannot be cut from a map that does not exist yet, and a vintage in the future clears every " +
          "refresh cadence for as long as it stands — the staleness check would never fire again. The vintage is " +
          "Operations' to correct; none is inferred here",
      ],
      "the extract's stated vintage is in the future",
    );
  }
  if (ageDays > extract.refreshCadenceDays) {
    return verdict(
      "D8",
      READINESS.FAIL,
      [
        `the extract's vintage ${extract.vintage} is ${ageDays} days old against a stated refresh cadence of ` +
          `${extract.refreshCadenceDays} days. A stale extract routes over a map the region no longer has, and it ` +
          "does so silently — every query still answers",
      ],
      "the extract is past its own stated refresh cadence",
    );
  }
  return verdict("D8", READINESS.PASS, [], `extract "${extract.identity}" at vintage ${extract.vintage}, ${ageDays} day(s) old against a ${extract.refreshCadenceDays}-day cadence`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   The five B1 steps
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {number} number
 * @param {string} title
 * @param {string} status
 * @param {string[]} blockedBy
 * @param {string} note
 * @returns {object} frozen
 */
function step(number, title, status, blockedBy, note) {
  return Object.freeze({ step: number, title, status, blockedBy: Object.freeze([...blockedBy]), note });
}

/**
 * The five steps of `b1Benchmark.js`'s own closing procedure (`:584–593`), each with the state
 * it is actually in.
 *
 * @param {{ d1: object, d3: object, d8: object, candidates: object }} input
 * @returns {object[]}
 */
function assessSteps(input) {
  const { d1, d3, d8, candidates } = input;
  const d1Ready = d1.status === READINESS.PASS;
  const d3Ready = d3.status === READINESS.PASS;
  const d8Ready = d8.status === READINESS.PASS;

  const step1Blockers = [];
  if (!d1Ready) step1Blockers.push("D1");
  if (!d3Ready) step1Blockers.push("D3");

  const step1 =
    step1Blockers.length > 0
      ? step(
          1,
          "deploy each candidate against the target region extract, per-profile contraction hierarchies BUILT",
          READINESS.BLOCKED,
          step1Blockers,
          step1Blockers.includes("D1")
            ? "BLOCKED — authoritative operating region unavailable" + (step1Blockers.includes("D3") ? "; fleet mobility/speed model unavailable" : "")
            : "BLOCKED — fleet mobility/speed model unavailable",
        )
      : step(
          1,
          "deploy each candidate against the target region extract, per-profile contraction hierarchies BUILT",
          candidates.deployed.length > 0 ? READINESS.NOT_MEASURED : READINESS.NOT_CONFIGURED,
          [],
          candidates.deployed.length > 0
            ? `D1 and D3 are supplied and ${candidates.deployed.length} candidate(s) are configured; the deployment and hierarchy build are an infrastructure action this tool does not perform and cannot observe`
            : "D1 and D3 are supplied; no candidate deployment is configured yet",
        );

  // Step 2 is the one step D1 never held: its contract is region-agnostic by construction and
  // ADR-33 released it. Its evidence is the roster below plus the adapter suite.
  const step2 = step(
    2,
    "one executable benchmark adapter per candidate, to the contract at b1Benchmark.js:84–98",
    candidates.implemented.length > 0 ? READINESS.PASS : READINESS.NOT_CONFIGURED,
    [],
    `${candidates.implemented.length} adapter(s) implemented (${candidates.implemented.join(", ")}); ` +
      `${candidates.notImplemented.length} candidate(s) correctly NOT_IMPLEMENTED (${candidates.notImplemented.join(", ") || "none"}) — ` +
      "no engine exists to adapt to and none was fabricated",
  );

  const step3 =
    step1.status === READINESS.BLOCKED
      ? step(3, "run the benchmark per candidate on representative hardware, record every row", READINESS.BLOCKED, step1Blockers, "BLOCKED via Step 1 — there is nothing deployed to measure")
      : step(3, "run the benchmark per candidate on representative hardware, record every row", READINESS.NOT_MEASURED, [], "no candidate has been measured against a built hierarchy");

  const step4Blockers = [];
  if (!d1Ready) step4Blockers.push("D1");
  if (!d8Ready) step4Blockers.push("D8");
  const step4 =
    step4Blockers.length > 0
      ? step(
          4,
          "record hierarchy build time and extract refresh cadence per candidate",
          READINESS.BLOCKED,
          step4Blockers,
          step4Blockers.includes("D8")
            ? "BLOCKED — extract vintage/refresh decision unavailable" + (step4Blockers.includes("D1") ? "; authoritative operating region unavailable" : "")
            : "BLOCKED — authoritative operating region unavailable",
        )
      : step(4, "record hierarchy build time and extract refresh cadence per candidate", READINESS.NOT_MEASURED, [], "no build time has been recorded");

  const priorEvidence = [step1, step3, step4].filter((entry) => entry.status === READINESS.PASS);
  const step5 = step(
    5,
    "ENGINE SELECTION — choose on recorded evidence and write the B1 ADR",
    READINESS.BLOCKED,
    [...new Set([...step1.blockedBy, ...step3.blockedBy, ...step4.blockedBy, ...(priorEvidence.length === 3 ? [] : ["Steps 1, 3, 4"])])],
    priorEvidence.length === 3
      ? "Steps 1, 3 and 4 have recorded evidence; the selection is a decision with an ADR and is deliberately not automated — §6.1 makes B1 a decision, not a benchmark result"
      : "BLOCKED — no recorded evidence exists. No engine is selected, ranked or recommended by this tool, and a capability fact about a candidate is not a recommendation",
  );

  return Object.freeze([step1, step2, step3, step4, step5]);
}

/**
 * The candidate roster, split into the three facts Step 2's status is read from.
 *
 * @returns {{ implemented: string[], notImplemented: string[], deployed: string[] }}
 */
function candidateStatus() {
  // Required lazily for the same reason `b1Benchmark.js` does it: requiring the registry
  // materialises every candidate against the environment.
  // eslint-disable-next-line global-require
  const registry = require("./adapters");
  const rows = registry.roster();
  return Object.freeze({
    implemented: Object.freeze(rows.filter((row) => row.status !== registry.AVAILABILITY.NOT_IMPLEMENTED).map((row) => row.id)),
    notImplemented: Object.freeze(rows.filter((row) => row.status === registry.AVAILABILITY.NOT_IMPLEMENTED).map((row) => row.id)),
    deployed: Object.freeze(rows.filter((row) => row.status === registry.AVAILABILITY.AVAILABLE).map((row) => row.id)),
  });
}

/**
 * The whole gate.
 *
 * @param {{ config?: object, env?: object, asOf?: string }} [options] `config` overrides the
 *   loaded deployment module, which is the seam the tests use so that no test writes a file
 *   into the operator's configuration path.
 * @returns {object} frozen
 */
function assess(options) {
  const settings = options || {};
  const loaded = settings.config !== undefined ? { ok: settings.config !== null, deployment: settings.config, reason: "" } : deployment.loadDeployment(settings.env);
  const config = loaded.ok ? loaded.deployment : null;

  const d1 = assessD1(config);
  const d3 = assessD3(config);
  // D8 is handed D1's validated declaration so that V-13 has the region it sizes the extract
  // against (F1). It is passed, never re-derived: two validations of one geometry are two
  // answers waiting to disagree.
  const d8 = assessD8(config, { asOf: settings.asOf, region: d1.region });
  const candidates = candidateStatus();
  const steps = assessSteps({ d1, d3, d8, candidates });

  // What the whole gate says in one word. `PASS` requires every step to have real evidence,
  // which no run of this tool can produce on its own — Steps 1, 3 and 4 are performed by
  // people against deployed engines, and this reports their state rather than standing in
  // for them.
  const blocked = steps.filter((entry) => entry.status === READINESS.BLOCKED);
  const overall = blocked.length > 0 ? READINESS.BLOCKED : steps.every((entry) => entry.status === READINESS.PASS) ? READINESS.PASS : READINESS.NOT_MEASURED;

  return Object.freeze({
    gate: "B1",
    overall,
    deploymentConfigured: loaded.ok,
    deploymentReason: loaded.reason,
    decisions: Object.freeze({ D1: d1, D3: d3, D8: d8 }),
    steps,
    candidates,
    /**
     * Whether a benchmark run made right now would be admissible as B1 Step 3 evidence.
     *
     * This is the field `b1Benchmark.js` reads. A run against a stub, or against a candidate
     * deployed over an extract that does not exist, still produces numbers — and those numbers
     * are a property of the harness. Marking them inadmissible at the source is the only thing
     * that stops them being quoted later as though they were the decision's evidence.
     */
    // PHASE 15 adversarial pass. This asked only whether Steps 1 and 3 were **not BLOCKED**,
    // and Step 1 has a fifth state: `NOT_CONFIGURED` — "D1 and D3 are supplied; no candidate
    // deployment is configured yet". So with the two decisions answered and **no candidate
    // deployed and no hierarchy built**, it reported `true`. That is reachable rather than
    // theoretical: `adapters/index.js:57–58` calls any module passed to `--engine ./x.js`
    // AVAILABLE on the strength of it exporting a `matrix()` function, so a hand-written
    // adapter is measured — and the gate would have called those numbers admissible Step 3
    // evidence while Step 1 had not been performed at all. Admissibility now requires Step 1
    // to have reached the state §12.2 describes as released — `NOT_MEASURED` or better. This
    // narrows the flag and never widens it; no threshold moves and no step becomes PASS.
    stepEvidenceAdmissible:
      (steps[0].status === READINESS.NOT_MEASURED || steps[0].status === READINESS.PASS) && steps[2].status !== READINESS.BLOCKED,
    engineSelected: false,
  });
}

/**
 * @param {object} report
 * @returns {string}
 */
function format(report) {
  const lines = [];
  lines.push("gate: B1 readiness (§5.2, §20.3, execution plan §6.1; report §36.8)");
  lines.push(`  OVERALL: ${report.overall}`);
  lines.push("");
  lines.push("  EXTERNAL DECISIONS — none of these is an engineering task:");
  for (const key of ["D1", "D3", "D8"]) {
    const entry = report.decisions[key];
    lines.push(`    ${entry.status.padEnd(15)} ${key}  [owner: ${entry.owner}]  ${entry.summary}`);
    for (const problem of entry.problems) lines.push(`                    · ${problem}`);
    // D2's residual rides with D1 because it is the check D1 field 2 releases (N23), and it is
    // reported separately because it is Architecture's to resolve rather than Operations'.
    if (entry.d2Residual) lines.push(`                    D2 residual (N23): ${entry.d2Residual.status} — ${entry.d2Residual.note}`);
  }
  lines.push("");
  lines.push("  B1 CLOSING STEPS (b1Benchmark.js:584–593):");
  for (const entry of report.steps) {
    lines.push(`    ${entry.status.padEnd(15)} step ${entry.step}  ${entry.title}`);
    lines.push(`                    ${entry.note}`);
    if (entry.blockedBy.length > 0) lines.push(`                    blocked by: ${entry.blockedBy.join(", ")}`);
  }
  lines.push("");
  lines.push(
    report.stepEvidenceAdmissible
      ? "  A benchmark run now WOULD be admissible as Step 3 evidence."
      : "  A benchmark run now would NOT be admissible as B1 Step 3 evidence: Step 1 has not been performed, so any\n" +
        "  number produced is a property of the harness and the two shipped caches, not of a candidate engine.",
  );
  lines.push("  NO ENGINE IS SELECTED, RANKED OR RECOMMENDED BY THIS TOOL. Selection is Step 5, on recorded evidence,");
  lines.push("  in an ADR. A capability fact about a candidate is a fact, not a recommendation.");
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {number} the exit code — always 0; see this file's header
 */
function main(argv) {
  const args = argv || [];
  // The CLI is the only place a date is read, and it is read once and passed in, so the report
  // is a pure function of its inputs everywhere else.
  const report = assess({ asOf: new Date().toISOString().slice(0, 10) });
  // eslint-disable-next-line no-console
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : format(report));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { READINESS, DECISION_OWNER, assessD1, assessD3, assessD8, assessSteps, candidateStatus, assess, format, main };
