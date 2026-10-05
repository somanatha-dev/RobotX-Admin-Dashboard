// Minimal fake Prisma client for unit tests. Every model method is a
// jest.fn() so tests configure only the calls their code path actually
// makes (via `.mockResolvedValue(...)` etc). `$transaction` runs the
// supplied callback against the same fake client, which is enough for the
// codebase's usage (no real isolation/rollback semantics needed for unit
// tests — nothing under test asserts transactional atomicity itself).
function createMockPrisma() {
  const client = {
    robot: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      // `findFirst`, `create`, `delete` and `count` are the calls the robot creation and
      // decommission paths actually make. Present here rather than assigned ad hoc by each
      // test, for the reason stated below about missing models: a fake client that lacks a
      // method the code under test calls turns a behavioural assertion into a TypeError
      // that some handler's catch swallows, which is a green test asserting nothing.
      findFirst: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    task: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
    },
    zone: {
      findMany: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
    },
    event: {
      create: jest.fn(),
    },
    telemetry: {
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    adminPinAuth: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    webAuthnCredential: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    campus: {
      findFirst: jest.fn(),
    },
    // §3.6's OperatingRegion. The request path looks a submission's region up by its
    // business key (`Region.regionId`) to obtain the `Region.id` every foreign key,
    // the region→shard map and the `cutover.engine_enabled` binding all mean — so a
    // fake client without this model turns that translation into a TypeError, which is
    // the "green test asserting nothing" failure the note above describes.
    region: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
    },
    // §3.5's published estate. `intake.resolveShardFor` reads it on the request path to
    // route a Leg to the shard that owns its region, so a fake client without it turns
    // intake's routing into the swallowed TypeError the note above describes.
    //
    // `findMany` resolves to `[]` rather than `undefined`: an empty `Shard` table is the
    // single-shard deployment, which is the world every test using this helper assumes,
    // and `undefined` would be a shape the real client never returns.
    shard: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(async () => 0),
    },
    // The §2.4 entities a legacy Task decomposes into, and the model rows a unit's
    // specification is written onto. Present so a unit test exercises the same shape the
    // production path does: a fake client that is missing a model a code path reads turns
    // a behavioural test into a `TypeError` swallowed by a handler's catch, which is a
    // green test asserting nothing.
    mission: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
    },
    leg: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    stop: {
      upsert: jest.fn(),
      update: jest.fn(),
    },
    payloadSpec: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    outbox: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    // §4.5's durable deadlines. Every Leg state entry registers one in the same
    // transaction, so any test that drives a Leg transition touches this model.
    timer: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(async ({ data }) => data),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
      upsert: jest.fn(async ({ create }) => create),
      count: jest.fn(async () => 0),
    },
    agent: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    // §2.7's append-only fact log. STEP 5 made the telemetry path a writer of it, so a
    // unit test of that path touches this model — and a fake client missing it would turn
    // the write into a TypeError the handler's catch swallows, which is the "green test
    // asserting nothing" failure the note above describes.
    observation: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(async ({ data }) => data),
      count: jest.fn(async () => 0),
    },
    agentCellPosition: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    commitment: {
      count: jest.fn(async () => 0),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    agentClass: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      // V1 demonstration: a simulated unit's class declaration writes these after the
      // upserts (`simulatedClassDeclaration.service`).
      update: jest.fn(async (args) => ({ id: args?.where?.id, ...(args?.data || {}) })),
    },
    mobilityModel: { upsert: jest.fn(), update: jest.fn(async (args) => ({ id: args?.where?.id })) },
    energyModel: { upsert: jest.fn(), update: jest.fn(async (args) => ({ id: args?.where?.id })) },
    containerModel: { upsert: jest.fn(), update: jest.fn(async (args) => ({ id: args?.where?.id })) },
    compartment: { upsert: jest.fn(async (args) => ({ id: "compartment-row", ...(args?.create || {}) })) },
    capabilityBundle: { upsert: jest.fn() },
    // The commissioning-time energy producer's two tables. Both are upsert-only here for
    // the same reason `applySpecification`'s rows are: the service writes them inside the
    // creation transaction, and a test that asserts on the *arguments* needs a spy, not a
    // store. They return the payload they were handed so a caller reading the result back
    // sees the row it asked for.
    batteryState: {
      upsert: jest.fn(async (args) => ({ id: "battery-state-row", ...(args?.create || {}) })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(),
    },
    energyModelParams: {
      upsert: jest.fn(async (args) => ({ id: "energy-params-row", ...(args?.create || {}) })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    capability: {
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    location: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    // C1 — the durable half of a robot's legacy session, which AUTH writes at pairing and
    // reads when the KV has no session. `updateMany` defaults to matching nothing, so a
    // test that has not seeded a durable session sees "no durable session", as before C1.
    robotSession: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    // An interactive transaction is handed a client that does **not** itself expose
    // `$transaction` — that is how Prisma's own type distinguishes the two, and
    // `engine/supervision/timers.requireTransaction` tests exactly that shape before it
    // will write a timer ("cancelling a timer happens in the transaction that enters or
    // exits the supervised state, §4.5"). Handing the callback the full client made every
    // such write throw, which a handler's catch then swallowed: a test that looked like it
    // exercised the transaction and in fact exercised the refusal.
    //
    // The model objects are shared by reference, so `expect(prisma.task.updateMany)` still
    // observes calls made through the transaction client.
    $transaction: jest.fn(async (fnOrArray) => {
      if (Array.isArray(fnOrArray)) return Promise.all(fnOrArray);
      const { $transaction, ...tx } = client;
      return fnOrArray(tx);
    }),
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(),
  };
  return client;
}

module.exports = { createMockPrisma };
