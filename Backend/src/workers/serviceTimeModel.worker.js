"use strict";

/**
 * The service-time model fitter (§13.2). **Tier 1** by path; its output is the decision
 * path's input.
 *
 * > Service time is *learned* per `(site, stop_type, mission_class, hour_of_week)` with
 * > **hierarchical shrinkage to broader cohorts when data is sparse**, because a busy office
 * > lobby with a lift, a kerbside handover, and a warehouse dock have service times that
 * > differ by an order of magnitude, and a single global constant guarantees systematic ETA
 * > error at every one of them.
 *
 * ── Why this is a worker and not a round-time computation ──────────────────
 * A fitted cohort is an **input** the round pins by version (§9.6 requirement 6). A model
 * that moved while a round was running would make two candidates for the same Leg evaluate
 * against different dwell distributions, which is a determinism failure rather than a
 * freshness improvement. So the fitter runs offline, writes a complete new version, and the
 * round switches versions between rounds, never within one — exactly the discipline
 * `energyCalibration.worker.js` applies to κ.
 *
 * ── The fit ────────────────────────────────────────────────────────────────
 * One pass over realised dwell observations, accumulating count, mean, and variance per
 * cohort at every level of §13.2's ladder. Then one pass down the ladder, shrinking each
 * cohort toward its parent:
 *
 * ```
 * w      = n / ( n + plan.service_time_shrinkage_strength )
 * mean   = w · sample_mean + (1 − w) · parent_mean
 * ```
 *
 * `plan/timeline.shrink()` is the shrinkage, imported rather than restated: the fitter and
 * the reader must apply the same weight to the same numbers, and two implementations of one
 * formula is how a fitted model and its consumer drift apart without either being wrong on
 * its own.
 *
 * ── What the fitter refuses ────────────────────────────────────────────────
 * An observation with no realised duration, a negative duration, or no stop type is
 * **dropped and counted**, never coerced. §16.3's attribution discipline applies for the
 * same reason it applies to κ: a dwell that overran because a lift was out of service is
 * evidence about that lift, not about the cohort's service-time distribution, and folding it
 * in corrupts the estimate in the direction that under-predicts every later mission.
 * `attributable: false` observations are excluded and reported.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `fit()`. This is the disposition every worker in this
 * codebase has: complete, tested, and inert behind `ENGINE_ENABLED`, with Phase 15 owning
 * production scheduling.
 */

const timeline = require("../engine/plan/timeline");
const { getPrisma } = require("../db/prisma");

/**
 * The ladder, broadest first — the order the shrinkage runs in.
 * @structural §13.2's own cohort hierarchy, reversed for the downward pass
 */
const LEVELS = Object.freeze([...timeline.COHORT_LEVELS].reverse());

/** Why an observation was dropped. */
const DROPPED = Object.freeze({
  NO_DURATION: "NO_REALISED_DURATION",
  NEGATIVE: "NEGATIVE_DURATION",
  NO_STOP_TYPE: "NO_STOP_TYPE",
  NOT_ATTRIBUTABLE: "NOT_ATTRIBUTABLE",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Accumulate count, mean, and variance per cohort in one pass.
 *
 * Welford's online update, so a long observation stream does not lose precision to
 * catastrophic cancellation in a naive sum-of-squares. The variance matters as much as the
 * mean here — §8.4 prices `p_late` from the predictive distribution — so an accumulator that
 * degrades it would quietly make every well-observed site look more punctual than it is.
 *
 * @param {Array<object>} observations `{ siteId, stopType, missionClass, hourOfWeek, durationSeconds, attributable }`
 * @returns {{ cohorts: Map<string, object>, dropped: Record<string, number>, used: number }}
 */
function accumulate(observations) {
  const cohorts = new Map();
  const dropped = { [DROPPED.NO_DURATION]: 0, [DROPPED.NEGATIVE]: 0, [DROPPED.NO_STOP_TYPE]: 0, [DROPPED.NOT_ATTRIBUTABLE]: 0 };
  let used = 0;

  for (const observation of observations || []) {
    const row = observation || {};
    if (row.attributable === false) {
      dropped[DROPPED.NOT_ATTRIBUTABLE] += 1;
      continue;
    }
    if (!isNumber(row.durationSeconds)) {
      dropped[DROPPED.NO_DURATION] += 1;
      continue;
    }
    if (row.durationSeconds < 0) {
      dropped[DROPPED.NEGATIVE] += 1;
      continue;
    }
    if (row.stopType === null || row.stopType === undefined || row.stopType === "") {
      dropped[DROPPED.NO_STOP_TYPE] += 1;
      continue;
    }

    used += 1;

    for (const level of LEVELS) {
      const key = timeline.cohortKey(level, row);
      if (key === null) continue;

      const current = cohorts.get(key) || {
        key,
        level: level.join("+"),
        discriminators: Object.fromEntries(level.map((field) => [field, row[field]])),
        n: 0,
        mean: 0,
        m2: 0,
      };
      current.n += 1;
      const delta = row.durationSeconds - current.mean;
      current.mean += delta / current.n;
      current.m2 += delta * (row.durationSeconds - current.mean);
      cohorts.set(key, current);
    }
  }

  return { cohorts, dropped, used };
}

/**
 * Shrink every accumulated cohort toward its parent, broadest first.
 *
 * @param {object} input
 * @param {Map<string, object>} input.cohorts
 * @param {number} input.priorSeconds `plan.service_time_prior[stop_type]` — a map or a scalar
 * @param {number} input.priorCv `plan.service_time_prior_cv`
 * @param {number} input.shrinkageStrength `plan.service_time_shrinkage_strength`
 * @returns {{ ok: boolean, rows: object[], problems: string[] }}
 */
function shrinkAll(input) {
  const source = input || {};
  const problems = [];

  if (!isNumber(source.priorCv) || source.priorCv < 0) problems.push("plan.service_time_prior_cv");
  if (!isNumber(source.shrinkageStrength) || source.shrinkageStrength <= 0) {
    problems.push("plan.service_time_shrinkage_strength");
  }
  if (problems.length > 0) return { ok: false, rows: [], problems };

  const priorFor = (stopType) => {
    const priors = source.priorSeconds;
    if (isNumber(priors)) return priors;
    if (priors && typeof priors === "object" && isNumber(priors[stopType])) return priors[stopType];
    return null;
  };

  const posteriors = new Map();
  const rows = [];

  // Broadest first, so a cohort's parent has already been shrunk when its own turn comes.
  // Within a level, canonical key order, so the emitted rows are identical across runs.
  for (const level of LEVELS) {
    const levelName = level.join("+");
    const keys = [...source.cohorts.keys()]
      .filter((key) => source.cohorts.get(key).level === levelName)
      .sort();

    for (const key of keys) {
      const cohort = source.cohorts.get(key);
      const stopType = cohort.discriminators.stopType;
      const prior = priorFor(stopType);
      if (prior === null) {
        problems.push(`plan.service_time_prior has no value for stop type "${String(stopType)}"`);
        continue;
      }

      // The parent is the same cohort with the rightmost discriminator dropped. Absent, the
      // parent is the configured prior — the root of §13.2's hierarchy, not a fallback.
      const parentLevel = level.slice(0, -1);
      const parentKey = parentLevel.length > 0 ? timeline.cohortKey(parentLevel, cohort.discriminators) : null;
      const parent =
        (parentKey !== null && posteriors.get(parentKey)) || {
          meanSeconds: prior,
          sdSeconds: prior * source.priorCv,
        };

      // Population variance from Welford's M2. A single observation has no dispersion of
      // its own, and the shrinkage below is what supplies one from the parent — reporting
      // zero would tell §8.4 that a once-observed site is perfectly predictable.
      const sampleSd = cohort.n > 1 ? Math.sqrt(cohort.m2 / (cohort.n - 1)) : parent.sdSeconds;

      const shrunk = timeline.shrink(
        { n: cohort.n, meanSeconds: cohort.mean, sdSeconds: sampleSd },
        parent,
        source.shrinkageStrength,
      );

      posteriors.set(key, { meanSeconds: shrunk.meanSeconds, sdSeconds: shrunk.sdSeconds });
      rows.push({
        cohortKey: key,
        level: levelName,
        siteId: cohort.discriminators.siteId ?? null,
        stopType: cohort.discriminators.stopType ?? null,
        missionClass: cohort.discriminators.missionClass ?? null,
        hourOfWeek: isNumber(cohort.discriminators.hourOfWeek) ? cohort.discriminators.hourOfWeek : null,
        meanSeconds: shrunk.meanSeconds,
        sdSeconds: shrunk.sdSeconds,
        sampleCount: cohort.n,
        shrinkageWeight: shrunk.weight,
        parentCohortKey: parentKey,
      });
    }
  }

  return { ok: problems.length === 0, rows, problems };
}

/**
 * Fit a complete new model version from an observation stream.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input
 * @param {Array<object>} input.observations
 * @param {number} input.version the version to write; a **new** one every fit, never an
 *   update, so a round that pinned the previous version can still be replayed
 * @param {object} input.parameters `{ priorSeconds, priorCv, shrinkageStrength }`
 * @param {boolean} [input.persist] write the rows; false returns them for inspection
 * @returns {Promise<{ ok: boolean, version: number, rows: object[], used: number,
 *                     dropped: object, written: number, problems: string[] }>}
 */
async function fit(deps, input) {
  const source = input || {};
  const accumulated = accumulate(source.observations);
  const shrunk = shrinkAll({ cohorts: accumulated.cohorts, ...(source.parameters || {}) });

  if (!shrunk.ok) {
    return {
      ok: false,
      version: source.version,
      rows: [],
      used: accumulated.used,
      dropped: accumulated.dropped,
      written: 0,
      problems: shrunk.problems,
    };
  }

  if (source.persist !== true) {
    return {
      ok: true,
      version: source.version,
      rows: shrunk.rows,
      used: accumulated.used,
      dropped: accumulated.dropped,
      written: 0,
      problems: [],
    };
  }

  const prisma = (deps && deps.prisma) || getPrisma();
  let written = 0;
  const problems = [];

  for (const row of shrunk.rows) {
    try {
      await prisma.serviceTimeModel.create({
        data: {
          version: source.version,
          siteId: row.siteId,
          stopType: row.stopType,
          missionClass: row.missionClass,
          hourOfWeek: row.hourOfWeek,
          meanSeconds: row.meanSeconds,
          sdSeconds: row.sdSeconds,
          sampleCount: row.sampleCount,
          parentCohortKey: row.parentCohortKey,
        },
      });
      written += 1;
    } catch (error) {
      problems.push(`${row.cohortKey}: ${error && error.message}`);
    }
  }

  return {
    ok: problems.length === 0,
    version: source.version,
    rows: shrunk.rows,
    used: accumulated.used,
    dropped: accumulated.dropped,
    written,
    problems,
  };
}

/**
 * Load one version into the map `plan/timeline.serviceTimeFor()` reads.
 *
 * ── Why the read is ordered, and why a collision is refused ─────────────────
 * §9.6 requirement 6 pins the model version so a decision replays against the same dwell
 * distributions it was taken against. That pin only delivers replay if one version maps
 * to one distribution per cohort. As shipped, this function read the version with no
 * `ORDER BY` and assigned `models[key]` as rows arrived, so two rows claiming one cohort
 * key left whichever the database listed last — and the unique index could not prevent
 * that pair, because four of its five columns are NULL for exactly the broad cohorts
 * §13.2's ladder falls back to and PostgreSQL's UNIQUE default is NULLS DISTINCT.
 *
 * Migration `20260818090000_service_time_model_nulls_not_distinct` closes that at the
 * storage layer. This is the second, independent half: the read is ordered so it is
 * reproducible against *any* database state, and a cohort claimed twice is **refused**
 * rather than resolved by arrival order. A pinned version that cannot name one
 * distribution per cohort is not a version a decision can be replayed against, and
 * silently picking one of two is precisely the failure the pin exists to exclude.
 *
 * @param {object} deps `{ prisma }`
 * @param {number} version
 * @returns {Promise<Record<string, object>>} keyed by `timeline.cohortKey()`
 * @throws {Error} when one cohort key is claimed by more than one row
 */
async function loadVersion(deps, version) {
  const prisma = (deps && deps.prisma) || getPrisma();
  const rows = await prisma.serviceTimeModel.findMany({
    where: { version },
    // Total and deterministic: `id` is unique, so the order does not depend on the plan
    // the database happened to choose.
    orderBy: [{ sampleCount: "desc" }, { fittedAt: "desc" }, { id: "asc" }],
  });

  const models = Object.create(null);
  const claimedBy = new Map();

  for (const row of rows) {
    for (const level of timeline.COHORT_LEVELS) {
      const key = timeline.cohortKey(level, row);
      if (key === null) continue;
      // Only the row whose own discriminator set matches this level's belongs at this key;
      // a broader row would otherwise claim a more specific cohort's slot.
      const matches = level.every((field) => row[field] !== null && row[field] !== undefined);
      const noExtras = ["siteId", "stopType", "missionClass", "hourOfWeek"]
        .filter((field) => !level.includes(field))
        .every((field) => row[field] === null || row[field] === undefined);
      if (!matches || !noExtras) continue;

      const incumbent = claimedBy.get(key);
      if (incumbent !== undefined) {
        throw new Error(
          `ServiceTimeModel version ${version} holds two rows for cohort "${key}" (${incumbent} and ` +
            `${row.id}). §9.6 requirement 6 pins the model version so a decision replays against the ` +
            "dwell distributions it was priced with; a version that cannot name one distribution per " +
            "cohort cannot deliver that, and choosing between them here would make the choice depend on " +
            "read order. Apply migration 20260818090000_service_time_model_nulls_not_distinct, which " +
            "reduces such groups and redeclares the key NULLS NOT DISTINCT so the pair cannot recur.",
        );
      }
      claimedBy.set(key, row.id);
      models[key] = { n: row.sampleCount, meanSeconds: row.meanSeconds, sdSeconds: row.sdSeconds };
    }
  }

  return models;
}

module.exports = {
  LEVELS,
  DROPPED,
  accumulate,
  shrinkAll,
  fit,
  loadVersion,
};
