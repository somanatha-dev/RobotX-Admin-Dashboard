"use strict";

/**
 * `src/db/schemaDrift.js` — the boot-time refusal of a database behind `prisma/migrations`.
 *
 * The defect it answers: `POST /api/simulator/robot` returned 500 at `tx.robot.create()`
 * because the database lacked `Robot.statusBeforeOffline` (and, further behind, `massKg`,
 * `simulated`, `simulationOwnerId`). These tests pin the comparison against a fake
 * `$queryRaw`; the live check against real migration levels is in the fix report.
 */

const {
  expectedColumns,
  findMissingColumns,
  assertSchemaMatchesClient,
} = require("../../../src/db/schemaDrift");

/** A DMMF-shaped model list small enough to reason about. */
const MODELS = [
  {
    name: "Robot",
    dbName: null,
    fields: [
      { name: "id", kind: "scalar", dbName: null },
      { name: "status", kind: "enum", dbName: null },
      { name: "statusBeforeOffline", kind: "enum", dbName: null },
      { name: "location", kind: "object", dbName: null },
    ],
  },
  {
    name: "Mapped",
    dbName: "mapped_table",
    fields: [{ name: "fieldName", kind: "scalar", dbName: "column_name" }],
  },
];

function rows(pairs) {
  return pairs.map(([table_name, column_name]) => ({ table_name, column_name }));
}

function fakePrisma(presentRows) {
  return { $queryRaw: jest.fn(async () => presentRows) };
}

describe("expectedColumns", () => {
  test("scalar and enum fields become columns; relations do not; @map/@@map are honoured", () => {
    expect(expectedColumns(MODELS)).toEqual([
      { table: "Robot", column: "id" },
      { table: "Robot", column: "status" },
      { table: "Robot", column: "statusBeforeOffline" },
      { table: "mapped_table", column: "column_name" },
    ]);
  });

  test("the generated client's own datamodel includes the Robot columns the create path writes", () => {
    const robot = expectedColumns().filter((c) => c.table === "Robot").map((c) => c.column);
    for (const column of ["massKg", "batteryReservePct", "simulated", "simulationOwnerId", "statusBeforeOffline"]) {
      expect(robot).toContain(column);
    }
    expect(robot).not.toContain("location");
  });
});

describe("findMissingColumns", () => {
  test("columns the database has beyond the client's are not a failure", () => {
    const expected = [{ table: "Robot", column: "id" }];
    expect(findMissingColumns(expected, rows([["Robot", "id"], ["Robot", "extra"], ["Other", "x"]]))).toEqual([]);
  });

  test("a column present on a different table does not satisfy the expectation", () => {
    const expected = [{ table: "Robot", column: "massKg" }];
    expect(findMissingColumns(expected, rows([["AgentClass", "massKg"]]))).toEqual(expected);
  });
});

describe("assertSchemaMatchesClient", () => {
  const FULL = rows([
    ["Robot", "id"],
    ["Robot", "status"],
    ["Robot", "statusBeforeOffline"],
    ["mapped_table", "column_name"],
  ]);

  test("a database at the client's level passes and reports how many columns it checked", async () => {
    await expect(assertSchemaMatchesClient(fakePrisma(FULL), { models: MODELS })).resolves.toEqual({ checked: 4 });
  });

  test("the observed drift (migration 33 absent) is refused, naming the column", async () => {
    const behind = FULL.filter((r) => r.column_name !== "statusBeforeOffline");
    const error = await assertSchemaMatchesClient(fakePrisma(behind), { models: MODELS }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("DATABASE_SCHEMA_BEHIND");
    expect(error.missing).toEqual([{ table: "Robot", column: "statusBeforeOffline" }]);
    expect(error.message).toContain("Robot.statusBeforeOffline");
    expect(error.message).toContain("prisma migrate deploy");
  });

  test("a missing table is refused as all of its columns", async () => {
    const error = await assertSchemaMatchesClient(fakePrisma(FULL.slice(0, 3)), { models: MODELS }).catch((e) => e);
    expect(error.missing).toEqual([{ table: "mapped_table", column: "column_name" }]);
  });

  test("a long list is named up to twelve and counts the rest", async () => {
    const wide = [{
      name: "Wide",
      dbName: null,
      fields: Array.from({ length: 15 }, (_, i) => ({ name: `c${i}`, kind: "scalar", dbName: null })),
    }];
    const error = await assertSchemaMatchesClient(fakePrisma([]), { models: wide }).catch((e) => e);
    expect(error.missing).toHaveLength(15);
    expect(error.message).toContain("Wide.c11");
    expect(error.message).not.toContain("Wide.c12");
    expect(error.message).toContain("and 3 more");
  });

  test("reads the connection's own schema only, with one read-only query", async () => {
    const prisma = fakePrisma(FULL);
    await assertSchemaMatchesClient(prisma, { models: MODELS });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = prisma.$queryRaw.mock.calls[0][0].join("");
    expect(sql).toMatch(/information_schema\.columns/);
    expect(sql).toMatch(/current_schema\(\)/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
  });
});
