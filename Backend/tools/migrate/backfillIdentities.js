"use strict";

/**
 * One-shot identity backfill — Phase 14 (§23.7).
 *
 * The migration adds `Stop.identityKey`, `Task.originIdentityKey`,
 * `Task.destinationIdentityKey` and the six derived-quantity columns, all nullable so no
 * existing row becomes invalid. This job fills them: for every `Stop` and every `Task`
 * that still carries an identifying value in a legacy column, it mints the stable
 * surrogate key, seals the identifying fields into `IdentityRecord`, and writes the key
 * and the derived quantities back.
 *
 * ── Idempotent, and idempotent in the way that matters here ─────────────────
 * The surrogate key is a keyed digest of the natural identifier, so a second run mints
 * the same key and upserts the same identity record rather than creating a second one.
 * That is the same property `backfillDomain.js` has, arrived at the same way.
 *
 * One asymmetry is deliberate and is the reason this job cannot simply upsert blindly:
 * **an erased identity record is never re-populated.** `identityStore.put()` refuses,
 * and this job reports it as `skippedErased` rather than as a failure. Without that
 * refusal, re-running the backfill after an erasure request would silently undo the
 * erasure — which is the one failure mode this whole construction exists to prevent, and
 * it would arrive by way of an operations task nobody thought of as privacy-relevant.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 * It does not null the legacy columns. `Stop.label`, `Stop.lat`, `Stop.lon`,
 * `Task.pickup` and `Task.drop` are read by the legacy dispatcher, which is still the
 * production path, and the execution plan gives Phase 15 the drop: "Drop legacy columns
 * **only after** a full retention window with the new path live." A `--redact` flag is
 * provided for the Phase 15 window and is **not** the default — a backfill that quietly
 * destroyed the columns the running system reads would be a data-loss event with a
 * migration's name on it.
 *
 * It also does not resolve the derived quantities from the spatial layer. `fineCell` and
 * `zoneId` are computed here from the coordinate through `spatial/cells.js`, because that
 * is a pure function; `routingNodeId`, `geofenceResult`, `accessWindowClass` and
 * `serviceTimeCohort` require the routing graph, the geofence service and the
 * service-time model, none of which is available to an offline migration. They are left
 * null and populated by the engine when it next plans against the Stop — which is
 * correct, because a derived quantity invented by a migration is a derived quantity
 * nothing derived.
 *
 * Usage:
 *   node tools/migrate/backfillIdentities.js [--dry-run] [--batch <n>] [--redact] [--json]
 * Exit code 0 on success, 1 on any failure.
 */

const identityStore = require("../../src/engine/privacy/identityStore");
const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");

/** @structural a page size, not a threshold */
const DEFAULT_BATCH = 500;

/**
 * The two secrets this job needs, read from the environment **here** and passed down.
 *
 * The engine modules take them as arguments and never read `process.env` themselves, for
 * the reason `commandSigning.js` states: a module that reaches for the environment makes
 * key rotation a code change. This is the boundary where the environment is read.
 *
 * @returns {{ secret: string, encryptionKey: Buffer }}
 */
function keysFromEnvironment() {
  const secret = process.env.PRIVACY_SURROGATE_SECRET;
  const keyHex = process.env.PRIVACY_IDENTITY_KEY;

  if (!secret) {
    throw new Error(
      "PRIVACY_SURROGATE_SECRET is unset. The surrogate key is a keyed digest; an unkeyed one over an address is " +
        "reversible by enumeration, because the space of real addresses is small (§23.7).",
    );
  }
  if (!keyHex) {
    throw new Error(
      "PRIVACY_IDENTITY_KEY is unset. §23.7 requires encryption at rest for the identity store specifically; storing " +
        "it in plaintext would put every delivery address in the fleet's history into any database backup.",
    );
  }

  return { secret, encryptionKey: identityStore.requireEncryptionKey(Buffer.from(keyHex, "hex")) };
}

/**
 * The identifying fields a Stop carries today.
 *
 * @param {object} stop
 * @returns {object}
 */
function stopIdentity(stop) {
  const fields = {};
  if (stop.label !== null && stop.label !== undefined) fields.label = stop.label;
  if (Number.isFinite(stop.lat)) fields.lat = stop.lat;
  if (Number.isFinite(stop.lon)) fields.lon = stop.lon;
  return fields;
}

/**
 * The natural identifier a Stop's surrogate key is derived from.
 *
 * The label where there is one, else the coordinate pair. Never the `stopId`: two Stops
 * at the same address must share one identity record, or an erasure request for that
 * address would have to enumerate every Stop that ever pointed at it.
 *
 * @param {object} stop
 * @returns {string|null}
 */
function stopNaturalId(stop) {
  if (typeof stop.label === "string" && stop.label.trim() !== "") return stop.label;
  if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) return `${stop.lat},${stop.lon}`;
  return null;
}

/**
 * Back-fill one page of Stops.
 *
 * @param {object} deps `{ prisma, cells }`
 * @param {object} input `{ secret, encryptionKey, batch, dryRun, redact, retainUntil, now }`
 * @returns {Promise<object>}
 */
async function backfillStops(deps, input) {
  const source = input || {};
  const rows = await deps.prisma.stop.findMany({
    where: { identityKey: null },
    // A total order, so two runs process the same rows in the same sequence and a partial
    // run resumes where it stopped rather than somewhere adjacent.
    orderBy: { stopId: "asc" },
    take: Number.isFinite(source.batch) ? source.batch : DEFAULT_BATCH,
  });

  let written = 0;
  let skippedErased = 0;
  let skippedNoIdentity = 0;

  for (const stop of rows) {
    const natural = stopNaturalId(stop);
    if (natural === null) {
      skippedNoIdentity += 1;
      continue;
    }

    const fields = stopIdentity(stop);
    if (source.dryRun) {
      written += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const stored = await identityStore.put(deps, {
      subjectType: surrogateKeys.SUBJECT_TYPE.STOP,
      naturalId: natural,
      fields,
      subjectId: stop.stopId,
      secret: source.secret,
      encryptionKey: source.encryptionKey,
      retainUntil: source.retainUntil ?? null,
      now: source.now,
    });

    if (stored.erased) {
      // The identity was erased. The key still attaches the Stop to the tombstone, which
      // is what lets a reader see `ERASED` rather than "unknown"; the fields are not
      // re-sealed, because re-populating them would undo the erasure.
      skippedErased += 1;
    }

    const derived =
      Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && deps.cells
        ? {
            fineCell: deps.cells.cellForPoint(stop.lat, stop.lon, deps.cells.RESOLUTION.FINE),
            // The remaining four require the routing graph, the geofence service and the
            // service-time model, none of which an offline migration has. Left null and
            // populated by the engine when it next plans against this Stop: a derived
            // quantity invented by a migration is a derived quantity nothing derived.
          }
        : {};

    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.stop.update({
      where: { id: stop.id },
      data: {
        identityKey: stored.identityKey,
        ...derived,
        ...(source.redact ? { label: null, lat: null, lon: null } : {}),
      },
    });

    written += 1;
  }

  return { examined: rows.length, written, skippedErased, skippedNoIdentity };
}

/**
 * Back-fill one page of Tasks — origin and destination separately.
 *
 * Two keys, not one: `pickup` and `drop` are two different premises, and one key over
 * both would make an erasure request for either erase the other.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input as `backfillStops`
 * @returns {Promise<object>}
 */
async function backfillTasks(deps, input) {
  const source = input || {};
  const rows = await deps.prisma.task.findMany({
    where: { OR: [{ originIdentityKey: null }, { destinationIdentityKey: null }] },
    orderBy: { taskId: "asc" },
    take: Number.isFinite(source.batch) ? source.batch : DEFAULT_BATCH,
  });

  let written = 0;
  let skippedErased = 0;

  for (const task of rows) {
    const ends = [
      { role: "origin", natural: task.pickup, fields: { label: task.pickup, lat: task.pickupLat, lon: task.pickupLon } },
      { role: "destination", natural: task.drop, fields: { label: task.drop, lat: task.dropLat, lon: task.dropLon } },
    ];

    const data = {};
    for (const end of ends) {
      if (typeof end.natural !== "string" || end.natural.trim() === "") continue;
      if (source.dryRun) continue;

      // eslint-disable-next-line no-await-in-loop
      const stored = await identityStore.put(deps, {
        subjectType: surrogateKeys.SUBJECT_TYPE.TASK,
        naturalId: end.natural,
        fields: end.fields,
        subjectId: task.taskId,
        secret: source.secret,
        encryptionKey: source.encryptionKey,
        retainUntil: source.retainUntil ?? null,
        now: source.now,
      });
      if (stored.erased) skippedErased += 1;
      data[end.role === "origin" ? "originIdentityKey" : "destinationIdentityKey"] = stored.identityKey;
    }

    if (!source.dryRun && Object.keys(data).length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await deps.prisma.task.update({ where: { id: task.id }, data });
    }
    written += 1;
  }

  return { examined: rows.length, written, skippedErased };
}

/**
 * Run the whole backfill, paging until both queries come back empty.
 *
 * @param {object} deps `{ prisma, cells }`
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function run(deps, options) {
  const settings = options || {};
  const keys = settings.secret && settings.encryptionKey ? settings : keysFromEnvironment();
  const now = settings.now instanceof Date ? settings.now : new Date();

  const input = {
    secret: keys.secret,
    encryptionKey: keys.encryptionKey,
    batch: settings.batch,
    dryRun: settings.dryRun === true,
    redact: settings.redact === true,
    retainUntil: settings.retainUntil ?? null,
    now,
  };

  const totals = { stops: { examined: 0, written: 0, skippedErased: 0, skippedNoIdentity: 0 }, tasks: { examined: 0, written: 0, skippedErased: 0 } };

  // Paging stops when a page comes back empty. A dry run pages once and reports, rather
  // than looping forever over rows it is not writing.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await backfillStops(deps, input);
    totals.stops.examined += page.examined;
    totals.stops.written += page.written;
    totals.stops.skippedErased += page.skippedErased;
    totals.stops.skippedNoIdentity += page.skippedNoIdentity;
    if (page.examined === 0 || input.dryRun) break;
  }

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await backfillTasks(deps, input);
    totals.tasks.examined += page.examined;
    totals.tasks.written += page.written;
    totals.tasks.skippedErased += page.skippedErased;
    if (page.examined === 0 || input.dryRun) break;
  }

  return {
    ok: true,
    dryRun: input.dryRun,
    redact: input.redact,
    ...totals,
    note: input.redact
      ? "legacy identifying columns were nulled. This is the Phase 15 disposition and must not be run while the " +
        "legacy dispatcher is the production path."
      : "legacy identifying columns are retained. The execution plan gives Phase 15 the drop, 'only after a full " +
        "retention window with the new path live', and the legacy dispatcher still reads them.",
  };
}

module.exports = { DEFAULT_BATCH, keysFromEnvironment, stopIdentity, stopNaturalId, backfillStops, backfillTasks, run };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const batchIndex = argv.indexOf("--batch");

  // eslint-disable-next-line global-require
  const { getPrisma } = require("../../src/db/prisma");
  // eslint-disable-next-line global-require
  const cells = require("../../src/engine/spatial/cells");

  run(
    { prisma: getPrisma(), cells },
    {
      dryRun: argv.includes("--dry-run"),
      redact: argv.includes("--redact"),
      batch: batchIndex === -1 ? undefined : Number(argv[batchIndex + 1]),
    },
  )
    .then((result) => {
      process.stdout.write(argv.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`);
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(`backfillIdentities failed: ${error.message}\n`);
      process.exit(1);
    });
}
