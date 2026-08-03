const { PrismaClient } = require("@prisma/client");

// Neon (and other cloud-hosted PG) can take several seconds to wake from
// suspension.  Patch DATABASE_URL with connect_timeout=30 once at module load
// so every Prisma connection attempt waits up to 30 s before timing out.
// This eliminates the P1001 "Can't reach database" on first startup without
// requiring any .env changes.
(function patchConnectTimeout() {
  const raw = process.env.DATABASE_URL;
  if (!raw || raw.includes("connect_timeout")) return;
  const sep = raw.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${raw}${sep}connect_timeout=30`;
})();

let prisma;

function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

async function connectPrisma() {
  const client = getPrisma();
  await client.$connect();
  return client;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectPrismaWithRetry({ retries = 4, delayMs = 3000, logger } = {}) {
  let attempt = 0;
  // Each attempt waits up to 30 s (connect_timeout in DATABASE_URL).
  // With retries=4 and delayMs=3s the max startup wait is ~4×30 + 3×3 = ~2 min.
  // In practice Neon wakes in <10 s so the first or second attempt always wins.
  while (true) {
    try {
      attempt += 1;
      const client = await connectPrisma();
      if (attempt > 1 && logger) {
        logger.info(`Prisma connected (attempt ${attempt})`);
      }
      return client;
    } catch (err) {
      const last = attempt >= retries;
      (logger || console).error("Prisma connect failed", {
        attempt,
        retries,
        errorCode: err?.errorCode,
        message: err?.message?.slice(0, 120),
      });

      if (last) throw err;
      await sleep(delayMs);
    }
  }
}

async function disconnectPrisma() {
  if (!prisma) return;
  await prisma.$disconnect();
  prisma = null;
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE 3 — the serialisable commit transaction (§10.3.2) and its escape hatch.
//
// §10.3.2 states the isolation requirement without room for interpretation:
//
//   > **Isolation level:** the transaction MUST run at `SERIALIZABLE`, or at
//   > `REPEATABLE READ` with explicit `FOR UPDATE` row locks on both the agent and
//   > the Leg. Relying on READ COMMITTED with a plain read-then-write is prohibited
//   > — the audit demonstrates the exact interleaving in which two transactions both
//   > observe a free agent and the second silently overwrites the first's binding,
//   > which no uniqueness constraint on the task side prevents.
//
// Blocking decision B9 in the execution plan records why this needs a helper at all:
// the ergonomic Prisma path (`prisma.$transaction(fn)`) runs at the connection's
// default isolation — READ COMMITTED on PostgreSQL — and `SELECT … FOR UPDATE` has
// no expression in the query builder. Both are reachable, but only deliberately.
//
// The commit path uses **both** legs of the specification's disjunction rather than
// choosing one: SERIALIZABLE isolation *and* explicit `FOR UPDATE` on the agent row
// and the Leg row, which is what §10.3.2 step 1 asks for in its own words ("an
// explicit row lock, not an optimistic read"). Belt and braces here is not
// over-engineering; it is the difference between a guarantee that survives a future
// change of isolation default and one that does not.
// ───────────────────────────────────────────────────────────────────────────

const ISOLATION_SERIALIZABLE = "Serializable";

/**
 * PostgreSQL's serialisation-failure and deadlock SQLSTATEs. A transaction that
 * aborts with one of these has not committed anything, so the caller may safely
 * return the pairing to the next round — which is what §10.3.2 prescribes for a
 * guard failure and is the same handling.
 */
const SERIALIZATION_FAILURE_CODES = Object.freeze(["40001", "40P01"]);

/**
 * Is this error PostgreSQL declining to serialise the transaction?
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isSerializationFailure(error) {
  if (!error) return false;
  const code = error.code || (error.meta && error.meta.code);
  if (typeof code === "string" && SERIALIZATION_FAILURE_CODES.includes(code)) return true;
  const message = typeof error.message === "string" ? error.message : "";
  return SERIALIZATION_FAILURE_CODES.some((sqlState) => message.includes(sqlState));
}

/**
 * Run `fn` inside a SERIALIZABLE transaction.
 *
 * Deliberately performs **no retry**. A retry loop here would need a bound, and a
 * bound is a behavioural constant that would have to be registered, owned, and
 * calibrated (§22.1). It would also be the wrong place: §10.3.2 says a failed commit
 * "returns the pairing to the next round with the cause recorded", and the round loop
 * (Phase 10) is what owns that decision. The commit path reports
 * `SERIALIZATION_FAILURE` and lets the coordinator decide.
 *
 * @param {object} client a `PrismaClient`
 * @param {(tx: object) => Promise<*>} fn
 * @param {{ timeoutMs?: number, maxWaitMs?: number }} [options]
 * @returns {Promise<*>}
 */
function runSerializable(client, fn, options) {
  const settings = options || {};
  const transactionOptions = { isolationLevel: ISOLATION_SERIALIZABLE };
  if (settings.timeoutMs !== undefined) transactionOptions.timeout = settings.timeoutMs;
  if (settings.maxWaitMs !== undefined) transactionOptions.maxWait = settings.maxWaitMs;
  return client.$transaction(fn, transactionOptions);
}

/**
 * `SELECT … FOR UPDATE` on one row, by primary key — §10.3.2 step 1's "explicit row
 * lock, not an optimistic read".
 *
 * The escape hatch is `$queryRawUnsafe` with a parameterised statement: the table name
 * is interpolated (it is a constant supplied by engine code, never by a request) while
 * every value travels as a bound parameter, so no caller-supplied value reaches the
 * SQL text.
 *
 * @param {object} tx the transaction client
 * @param {string} table the quoted-identifier table name, e.g. `Agent`
 * @param {string} column the primary-key column, e.g. `id`
 * @param {string} value
 * @returns {Promise<object|null>}
 */
async function selectForUpdate(tx, table, column, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new TypeError("selectForUpdate takes identifiers from engine code, never from request input");
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`,
    value,
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

module.exports = {
  getPrisma,
  connectPrisma,
  connectPrismaWithRetry,
  disconnectPrisma,
  ISOLATION_SERIALIZABLE,
  SERIALIZATION_FAILURE_CODES,
  isSerializationFailure,
  runSerializable,
  selectForUpdate,
};
