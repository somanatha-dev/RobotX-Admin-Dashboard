"use strict";

/**
 * **Does the connected database have every column this build reads and writes?** — checked
 * once at boot, before the server accepts a request.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * A database that is behind `prisma/migrations` does not fail at connect. It fails on the
 * first query that names a missing column, as a Prisma `P2022`, and every such query fails
 * the same way. `POST /api/simulator/robot` answered 500 at the Robot insert in `robot.service.js` on a
 * database twelve migrations behind (the column named was `massKg`, `simulated`,
 * `simulationOwnerId` or `statusBeforeOffline` depending on how far behind), and nothing
 * about it said "database" — the create path itself was correct at the schema it ships
 * with. A process that cannot read or write its core rows should say so once, at boot,
 * naming the columns, rather than per request as an Internal Server Error.
 *
 * ── What it compares, and why not the migration ledger ─────────────────────
 * The expected set is the generated client's own datamodel (`Prisma.dmmf`): every scalar
 * and enum field of every model, as the column it maps to. That is exactly the set a
 * `P2022` can name. The present set is `information_schema.columns` for the connection's
 * schema. `_prisma_migrations` is deliberately not consulted: the V1 runbook applies
 * `migration.sql` files with `psql`, which leaves no ledger, and a ledger can say "applied"
 * about a column someone dropped by hand. The columns are the fact; the ledger is a claim.
 *
 * Read-only, one query. It checks presence only — not types, constraints or indexes — so it
 * cannot refuse a database that would have worked; it refuses one that provably cannot.
 */

const { Prisma } = require("@prisma/client");

/** How many missing columns the refusal names before summarising the rest. */
const NAMED_IN_MESSAGE = 12;

/**
 * The columns the generated client selects and writes, as `{ table, column }`.
 *
 * @param {ReadonlyArray<object>} [models] DMMF models; defaults to the generated client's
 * @returns {Array<{ table: string, column: string }>}
 */
function expectedColumns(models = Prisma.dmmf.datamodel.models) {
  const out = [];
  for (const model of models) {
    const table = model.dbName || model.name;
    for (const field of model.fields) {
      if (field.kind !== "scalar" && field.kind !== "enum") continue;
      out.push({ table, column: field.dbName || field.name });
    }
  }
  return out;
}

/**
 * @param {Array<{ table: string, column: string }>} expected
 * @param {Array<{ table_name: string, column_name: string }>} presentRows
 * @returns {Array<{ table: string, column: string }>} expected columns absent from the database
 */
function findMissingColumns(expected, presentRows) {
  const present = new Set(presentRows.map((row) => `${row.table_name}.${row.column_name}`));
  return expected.filter(({ table, column }) => !present.has(`${table}.${column}`));
}

/**
 * Refuse to proceed when the database lacks a column the client needs.
 *
 * @param {object} prisma a connected PrismaClient
 * @param {{ models?: ReadonlyArray<object> }} [options]
 * @returns {Promise<{ checked: number }>}
 * @throws {Error} code `DATABASE_SCHEMA_BEHIND`, with `missing` listing every absent column
 */
async function assertSchemaMatchesClient(prisma, options = {}) {
  const expected = expectedColumns(options.models);
  const presentRows = await prisma.$queryRaw`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()`;
  const missing = findMissingColumns(expected, presentRows);
  if (missing.length === 0) return { checked: expected.length };

  const named = missing.slice(0, NAMED_IN_MESSAGE).map(({ table, column }) => `${table}.${column}`);
  const more = missing.length > named.length ? ` and ${missing.length - named.length} more` : "";
  const err = new Error(
    `The database is missing ${missing.length} column(s) this build reads and writes: ` +
      `${named.join(", ")}${more}. It is behind prisma/migrations, and every query naming them ` +
      "would fail (P2022 for a missing column, P2021 for a missing table). Apply the pending migrations to this database " +
      "(`npx prisma migrate deploy`, or the runbook's psql sequence for a throwaway cluster) " +
      "and start again.",
  );
  err.code = "DATABASE_SCHEMA_BEHIND";
  err.missing = missing;
  throw err;
}

module.exports = { expectedColumns, findMissingColumns, assertSchemaMatchesClient };
