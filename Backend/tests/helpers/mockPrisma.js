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
      update: jest.fn(),
      updateMany: jest.fn(),
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
    $transaction: jest.fn(async (fnOrArray) => {
      if (Array.isArray(fnOrArray)) return Promise.all(fnOrArray);
      return fnOrArray(client);
    }),
    $queryRaw: jest.fn(),
  };
  return client;
}

module.exports = { createMockPrisma };
