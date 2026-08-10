"use strict";

/**
 * The spatial hierarchy: region, site, zone, cell (§3.6).
 *
 * Four spatial units appear across the specification, each introduced by the
 * mechanism that needs it: **region** as the sharding key (§3.5), **site** as a
 * configuration scope (§22.2), **zone** as the unit prices are keyed by (§8.3), and
 * **cell** as the index and cache key (§6.2, §20.3). §3.6 states their containment
 * once, "because four scoping units with unstated containment produce inconsistent
 * configuration scoping in practice".
 *
 * Three rules make it usable rather than merely descriptive, and this module is
 * each of them made executable:
 *
 * 1. **Containment is by assignment, not by geometry.** The cell→zone and cell→site
 *    maps are published configuration, versioned, and pinned into the round snapshot
 *    like any other input (§9.6). `resolve()` reads a published map; it computes no
 *    intersection and takes no coordinates.
 * 2. **A zone never straddles a region.** Were it permitted to, `λ_zone` would be
 *    estimated from demand served by two independent shards, and the pruning bound's
 *    `Ω_terminal` — a maximum over prices *within the search region* (§6.4) — would
 *    no longer bound anything the shard can actually reach.
 * 3. **Sites and zones are orthogonal, and deliberately so.** Site is *where service
 *    behaviour is learned*; zone is *where supply is priced*. Forcing one to nest
 *    inside the other would make one of the two the wrong shape for its purpose.
 *
 * ── Where validation lives ──────────────────────────────────────────────────
 * Rules 2 and 3 are enforced at **publish time** by the Config Service's V8 check,
 * which Phase 1 already shipped: a zone spanning regions, a fine cell mapping to
 * two zones, or a fine cell mapping to two sites is refused before the version
 * exists (§22.1 rule 5). `validate()` here is the same rule set expressed over an
 * in-memory map, so a caller can check a map it is *about to* publish, and so
 * Phase 2's seeded maps can be checked without a database. The two agree by
 * construction: `validate()`'s findings are a superset of V8's, adding only the
 * completeness checks V8 cannot make without the region list.
 */

const { canonicalCellOrder, isCellId, normaliseCellId, RESOLUTION, validateAssignment } = require("./cells");
// PHASE 15 — V-10 lives beside the rest of the D1 gate rather than being restated here. A
// second copy of "what a published cell id must be" is a second thing to get wrong when §6.2's
// site-local carve-out is revisited.
const regionBoundary = require("./regionBoundary");

/**
 * The containment order §3.6 tabulates, top-first. `region` is the top of the
 * spatial hierarchy; a cell is the leaf.
 * @structural the specification's own unit names
 */
const SPATIAL_UNITS = Object.freeze(["region", "site", "zone", "cell"]);

/**
 * Build an indexed, immutable view of a published spatial map.
 *
 * The input shape is the one the Config Service already validates and carries in a
 * published version's payload (`snapshot.spatial`), so a map is indexed the same way
 * whether it came from a pinned configuration version, from the durable
 * `CellAssignment` mirror, or from a seed file.
 *
 * @param {{ regions?: object[], zones?: object[], sites?: object[], cells?: object[] }} map
 * @returns {object} an immutable index with `resolve`, `cellsOfZone`, `cellsOfSite`
 */
function indexMap(map) {
  const source = map || {};

  const regions = new Map();
  for (const region of source.regions || []) {
    if (region && region.id) regions.set(String(region.id), Object.freeze({ ...region }));
  }

  const zones = new Map();
  for (const zone of source.zones || []) {
    if (zone && zone.id) zones.set(String(zone.id), Object.freeze({ ...zone }));
  }

  const sites = new Map();
  for (const site of source.sites || []) {
    if (site && site.id) sites.set(String(site.id), Object.freeze({ ...site }));
  }

  const cells = new Map();
  const zoneCells = new Map();
  const siteCells = new Map();
  for (const assignment of source.cells || []) {
    if (!assignment || !isCellId(assignment.cellId)) continue;
    const cellId = normaliseCellId(assignment.cellId);
    cells.set(cellId, Object.freeze({ ...assignment, cellId }));

    if (assignment.zoneId) {
      const list = zoneCells.get(String(assignment.zoneId)) || [];
      list.push(cellId);
      zoneCells.set(String(assignment.zoneId), list);
    }
    if (assignment.siteId) {
      const list = siteCells.get(String(assignment.siteId)) || [];
      list.push(cellId);
      siteCells.set(String(assignment.siteId), list);
    }
  }

  const index = {
    version: source.version === undefined ? null : source.version,
    regions,
    zones,
    sites,
    cells,
    /**
     * Resolve a cell's containment chain from the published assignment.
     *
     * @param {string} cellId
     * @returns {{ cellId: string, resolution: string|null, zoneId: string|null,
     *             siteId: string|null, regionId: string|null, assigned: boolean }}
     */
    resolve(cellId) {
      let key;
      try {
        key = normaliseCellId(cellId);
      } catch {
        return unassigned(String(cellId));
      }
      const assignment = cells.get(key);
      if (!assignment) return unassigned(key);

      // The region is read from the cell's own assignment, then cross-checked
      // against the zone's. §3.6 rule 2 means the two must agree; where they do not,
      // the map is invalid and `validate()` reports it — `resolve()` reports the
      // cell's own assignment and does not silently pick a winner.
      const zone = assignment.zoneId ? zones.get(String(assignment.zoneId)) : null;
      return Object.freeze({
        cellId: key,
        resolution: assignment.resolution || null,
        zoneId: assignment.zoneId ? String(assignment.zoneId) : null,
        siteId: assignment.siteId ? String(assignment.siteId) : null,
        regionId: assignment.regionId
          ? String(assignment.regionId)
          : zone && zone.regionId
            ? String(zone.regionId)
            : null,
        assigned: true,
      });
    },
    /**
     * @param {string} zoneId
     * @returns {string[]} the zone's cell set, canonically ordered
     */
    cellsOfZone(zoneId) {
      return canonicalCellOrder(zoneCells.get(String(zoneId)) || []);
    },
    /**
     * @param {string} siteId
     * @returns {string[]} the site's cell set, canonically ordered
     */
    cellsOfSite(siteId) {
      return canonicalCellOrder(siteCells.get(String(siteId)) || []);
    },
  };

  return Object.freeze(index);
}

/**
 * The answer for a cell the published map does not assign.
 *
 * `assigned: false` rather than a guessed containment: §3.6 forbids deriving
 * containment at query time, and §4.1 rule 3 forbids inferring state from the
 * absence of data. A caller that needs a zone for an unassigned cell has found a
 * hole in the map, which is a configuration defect to report — not a geometry
 * problem to solve.
 *
 * @param {string} cellId
 * @returns {object}
 */
function unassigned(cellId) {
  return Object.freeze({
    cellId,
    resolution: null,
    zoneId: null,
    siteId: null,
    regionId: null,
    assigned: false,
  });
}

/**
 * Validate a spatial map against §3.6's containment rules.
 *
 * Every finding names the rule it enforces and the consequence §3.6 states for
 * breaking it, so an operator reading a rejection learns why rather than only that.
 *
 * @param {{ regions?: object[], zones?: object[], sites?: object[], cells?: object[] }} map
 * @returns {{ ok: boolean, problems: string[] }}
 */
function validate(map) {
  const problems = [];
  const source = map || {};

  const regionIds = new Set();
  for (const region of source.regions || []) {
    if (!region || !region.id) {
      problems.push("a region has no id");
      continue;
    }
    if (regionIds.has(String(region.id))) problems.push(`region "${region.id}" is declared twice`);
    regionIds.add(String(region.id));
  }

  // ── Rule 2: a zone never straddles a region ───────────────────────────────
  const zoneRegion = new Map();
  for (const zone of source.zones || []) {
    if (!zone || !zone.id) {
      problems.push("a zone has no id");
      continue;
    }
    const id = String(zone.id);
    if (!zone.regionId) {
      problems.push(`zone "${id}" names no region; a zone is contained in exactly one region (§3.6)`);
    } else if (regionIds.size > 0 && !regionIds.has(String(zone.regionId))) {
      problems.push(`zone "${id}" names region "${zone.regionId}", which the map does not declare`);
    }
    if (zoneRegion.has(id) && zoneRegion.get(id) !== String(zone.regionId)) {
      problems.push(
        `zone "${id}" is assigned to more than one region. A zone that spans two regions means λ_zone is ` +
          "estimated from demand served by two independent shards, and Ω_terminal no longer bounds the " +
          "prices the shard can reach (§3.6, §6.4)",
      );
    }
    zoneRegion.set(id, String(zone.regionId));
  }

  const siteRegion = new Map();
  for (const site of source.sites || []) {
    if (!site || !site.id) {
      problems.push("a site has no id");
      continue;
    }
    const id = String(site.id);
    if (!site.regionId) {
      problems.push(`site "${id}" names no region; a site is contained in exactly one region (§3.6)`);
    } else if (regionIds.size > 0 && !regionIds.has(String(site.regionId))) {
      problems.push(`site "${id}" names region "${site.regionId}", which the map does not declare`);
    }
    siteRegion.set(id, String(site.regionId));
  }

  // ── Rule 1: every fine cell maps to exactly one zone and at most one site ──
  const cellZones = new Map();
  const cellSites = new Map();
  for (const assignment of source.cells || []) {
    problems.push(...validateAssignment(assignment));
    if (!assignment || !isCellId(assignment.cellId)) continue;
    const cellId = normaliseCellId(assignment.cellId);

    const zonesForCell = cellZones.get(cellId) || new Set();
    if (assignment.zoneId) zonesForCell.add(String(assignment.zoneId));
    cellZones.set(cellId, zonesForCell);

    const sitesForCell = cellSites.get(cellId) || new Set();
    if (assignment.siteId) sitesForCell.add(String(assignment.siteId));
    cellSites.set(cellId, sitesForCell);

    if (assignment.zoneId && zoneRegion.size > 0) {
      const zoneRegionId = zoneRegion.get(String(assignment.zoneId));
      if (zoneRegionId === undefined) {
        problems.push(`cell "${cellId}" is assigned to zone "${assignment.zoneId}", which the map does not declare`);
      } else if (assignment.regionId && String(assignment.regionId) !== zoneRegionId) {
        problems.push(
          `cell "${cellId}" names region "${assignment.regionId}" but its zone "${assignment.zoneId}" ` +
            `lies in region "${zoneRegionId}". Containment must agree at every level (§3.6)`,
        );
      }
    }

    if (assignment.siteId && siteRegion.size > 0) {
      const siteRegionId = siteRegion.get(String(assignment.siteId));
      if (siteRegionId === undefined) {
        problems.push(`cell "${cellId}" is assigned to site "${assignment.siteId}", which the map does not declare`);
      } else if (assignment.regionId && String(assignment.regionId) !== siteRegionId) {
        problems.push(
          `cell "${cellId}" names region "${assignment.regionId}" but its site "${assignment.siteId}" ` +
            `lies in region "${siteRegionId}". Containment must agree at every level (§3.6)`,
        );
      }
    }
  }

  for (const [cellId, zonesForCell] of cellZones.entries()) {
    const assignment = (source.cells || []).find(
      (candidate) => candidate && isCellId(candidate.cellId) && normaliseCellId(candidate.cellId) === cellId,
    );
    const isFine = assignment && assignment.resolution === RESOLUTION.FINE;
    if (isFine && zonesForCell.size !== 1) {
      problems.push(
        `fine cell "${cellId}" maps to ${zonesForCell.size} zones; every fine cell maps to exactly one. ` +
          "Containment is by published assignment, not query-time geometry (§3.6)",
      );
    }
  }

  for (const [cellId, sitesForCell] of cellSites.entries()) {
    if (sitesForCell.size > 1) {
      problems.push(
        `fine cell "${cellId}" maps to ${sitesForCell.size} sites; every fine cell maps to at most one (§3.6)`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Validate a spatial map against §3.6's containment rules **and** against B5 — that is,
 * everything `validate()` checks plus the requirement that a published cell id actually be
 * the thing it claims to be (§30.5.5 V-10).
 *
 * ── Why this is a second function rather than a stricter `validate()` ──────
 * The two answer different questions, and both are needed.
 *
 * `validate()` is Phase 2's, and Phase 2 was deliberately built against an **opaque token**
 * because B5 — H3 versus S2 versus site-local graph zones — was open (`cells.js`'s header
 * states this outright). It checks containment, it is what the durable `CellAssignment` mirror
 * and the seed are validated by, and tightening it would be re-litigating a decision Phase 2
 * made correctly.
 *
 * `validateForPublish()` is the question the Config Service asks: *may this map become the
 * operating region's published configuration?* B5 is now settled (`cells.js:29–39`, H3, res
 * 8/5), so at **that** moment a cell id is an H3 index unless it is §6.2 site-local space and
 * says so. §30.5.2 records the gap this closes as **N21**: a map whose every cell id is a
 * placeholder token passes the full spatial validation with zero problems, which means the
 * publish path "would today accept a fabricated, geometry-free region map indistinguishable
 * from a derived one".
 *
 * The publish path enforces the same rule as a blocking finding (`validators.js` A6); this
 * function exists so a caller can check a map it is *about to* publish, exactly as
 * `validate()` does for containment.
 *
 * @param {{ regions?: object[], zones?: object[], sites?: object[], cells?: object[] }} map
 * @returns {{ ok: boolean, problems: string[] }}
 */
function validateForPublish(map) {
  const containment = validate(map);
  const problems = [...containment.problems];
  const source = map || {};

  for (const assignment of source.cells || []) {
    if (!assignment || !isCellId(assignment.cellId)) continue;
    const expected = assignment.resolution === RESOLUTION.COARSE ? RESOLUTION.COARSE : RESOLUTION.FINE;
    problems.push(...regionBoundary.validateCellIdentity(assignment, expected));
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Convert a map into the payload shape the Config Service publishes and validates
 * (`validators.js` V8), so the same map object serves both the durable mirror and
 * the pinned configuration version.
 *
 * ── Why `cells` carries the fine cells only ─────────────────────────────────
 * §3.6 states the containment rule for fine cells alone: "A fine cell lies in
 * exactly one zone **by assignment**". A coarse cell is the §6.2 *regional sweep*
 * index — it spans many zones by construction, which is what makes it useful for
 * the sweep — so requiring it to name exactly one zone would be requiring the wrong
 * thing.
 *
 * Phase 1's V8 reads `spatial.cells` as the fine cell→zone map and checks exactly
 * that rule. Publishing coarse cells in the same array would make a correct map
 * fail a correct check. They are therefore published under `coarseCells`, where
 * Phase 9's Availability Index reads them and where no containment rule applies to
 * them. The durable `CellAssignment` mirror carries both, distinguished by its
 * `resolution` column.
 *
 * @param {{ regions?: object[], zones?: object[], sites?: object[], cells?: object[] }} map
 * @returns {{ regions: object[], zones: object[], sites: object[], cells: object[], coarseCells: object[] }}
 */
function toConfigPayload(map) {
  const source = map || {};
  const project = (assignment) => ({
    cellId: normaliseCellId(assignment.cellId),
    resolution: assignment.resolution || null,
    regionId: assignment.regionId ? String(assignment.regionId) : null,
    zoneId: assignment.zoneId ? String(assignment.zoneId) : null,
    siteId: assignment.siteId ? String(assignment.siteId) : null,
    // PHASE 15 — carried so the publish-time check (A6) reads the map's own declaration rather
    // than inferring one. Absent means H3 (`regionBoundary.CELL_INDEXING`): the exemption is
    // claimed explicitly or it is not claimed, because an inferred exemption is no check.
    indexing: assignment.indexing === undefined || assignment.indexing === null ? null : String(assignment.indexing),
  });

  const all = (source.cells || []).map(project);

  return {
    regions: (source.regions || []).map((region) => ({ id: String(region.id), name: region.name || null })),
    zones: (source.zones || []).map((zone) => ({ id: String(zone.id), regionId: zone.regionId ? String(zone.regionId) : null })),
    sites: (source.sites || []).map((site) => ({ id: String(site.id), regionId: site.regionId ? String(site.regionId) : null })),
    cells: all.filter((assignment) => assignment.resolution === RESOLUTION.FINE),
    coarseCells: all.filter((assignment) => assignment.resolution !== RESOLUTION.FINE),
  };
}

module.exports = {
  SPATIAL_UNITS,
  indexMap,
  validate,
  validateForPublish,
  toConfigPayload,
};
