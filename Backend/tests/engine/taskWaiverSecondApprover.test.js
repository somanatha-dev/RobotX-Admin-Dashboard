"use strict";

/**
 * §7.2 / §23.6 — a class C (contractual) waiver on `POST /api/tasks/assign` names a second
 * approver, and that approver is an existing account holding a role the policy admits.
 *
 * The route gate here is MANUAL_ASSIGNMENT_AGAINST_POLICY, which requires no second approver by
 * default, so the waiver decision in `tasks.controller` is the only place a class C waiver's
 * approver is checked. It used to check the identity string alone (present, distinct from the
 * caller): any made-up value passed. It now resolves the identity through the same verification
 * the shared gate uses (`auth_middleware.verifySecondApprover`).
 *
 * What this verifies is account existence and an admitted role — not that the person behind the
 * account consented. Isolated: mocked Prisma, stubbed task intake, no database, no network.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const override = require("../../src/engine/security/override");

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  auditEvent: { findFirst: jest.fn(), create: jest.fn() },
  overrideAudit: { create: jest.fn() },
  configVersion: { findFirst: jest.fn(), findMany: jest.fn() },
  configActiveVersion: { findUnique: jest.fn() },
  $transaction: jest.fn(async (callback) => callback(mockPrismaClient)),
};

jest.mock("../../src/db/prisma", () => ({
  getPrisma: () => mockPrismaClient,
  connectPrisma: jest.fn(),
  connectPrismaWithRetry: jest.fn(),
  disconnectPrisma: jest.fn(),
}));

// The intake itself is not under test: a granted waiver reaching it is the observable outcome.
jest.mock("../../src/services/task.service", () => ({
  ...jest.requireActual("../../src/services/task.service"),
  assignTask: jest.fn(),
}));

const taskService = require("../../src/services/task.service");
const app = require("../../src/app");

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "ops@robotx.test", role: "SUPER_ADMIN" };
const VIEWER = { ...USER, role: "VIEWER" };
const APPROVER = { id: "22222222-2222-4222-8222-222222222222", role: "SUPER_ADMIN" };
const NOBODY = "33333333-3333-4333-8333-333333333333";
const token = () => jwt.sign({ id: USER.id }, process.env.JWT_SECRET);
const accounts = (...rows) => async ({ where }) => rows.find((row) => row.id === where.id) || null;

// F4 is class C in the feasibility register; asserted, so a register change cannot silently turn
// these into tests of some other class.
const CLASS_C = "F4";
const CLASS_P = "F2";

beforeEach(() => {
  mockPrismaClient.user.findUnique.mockReset();
  mockPrismaClient.user.findUnique.mockImplementation(accounts(USER, APPROVER));
  mockPrismaClient.auditEvent.findFirst.mockResolvedValue(null);
  mockPrismaClient.auditEvent.create.mockImplementation(async ({ data }) => ({ ...data }));
  mockPrismaClient.overrideAudit.create.mockResolvedValue({});
  taskService.assignTask.mockResolvedValue({ id: "task-row-1", status: "PENDING", robotId: null, intake: { accepted: true } });
  app.locals.prisma = mockPrismaClient;
});

const assign = (body) =>
  request(app)
    .post("/api/tasks/assign")
    .set("Authorization", `Bearer ${token()}`)
    .send({ taskId: "TSK-W-1", reason: "customer agreed to the late window", waivePredicate: CLASS_C, ...body });

const approverLookups = () => mockPrismaClient.user.findUnique.mock.calls.filter(([args]) => args.where.id !== USER.id);
// The waiver decision's audit row — the one carrying the predicate (the route gate writes its own).
const waiverAuditRow = () => mockPrismaClient.overrideAudit.create.mock.calls.map(([args]) => args.data).find((row) => row.predicateId);

function refusedAndNotAssigned(response, refusal) {
  expect(response.body).toMatchObject({ ok: false, refusal, predicateId: CLASS_C, constraintClass: "C" });
  expect(taskService.assignTask).not.toHaveBeenCalled();
}

test("the fixture's predicates have the classes these tests assume", () => {
  const register = require("../../src/engine/feasibility/register");
  expect(register.predicate(CLASS_C).constraintClass).toBe("C");
  expect(register.predicate(CLASS_P).constraintClass).toBe("P");
});

describe("class C waiver — the second approver is an existing, authorised account", () => {
  test("a valid distinct elevated approver: looked up by id, the waiver is granted and the task reaches intake", async () => {
    const response = await assign({ secondApproverId: APPROVER.id }).expect(200);
    expect(response.body.ok).toBe(true);
    expect(taskService.assignTask).toHaveBeenCalledTimes(1);
    expect(approverLookups()).toEqual([[{ where: { id: APPROVER.id }, select: { id: true, role: true } }]]);
    expect(waiverAuditRow()).toMatchObject({ granted: true, predicateId: CLASS_C, constraintClass: "C", secondApproverId: APPROVER.id, refusalReason: null });
  });

  test("a well-formed id naming no account is refused, and the refusal is audited with the predicate", async () => {
    const response = await assign({ secondApproverId: NOBODY }).expect(403);
    refusedAndNotAssigned(response, override.REFUSAL.SECOND_APPROVER_UNKNOWN);
    expect(waiverAuditRow()).toMatchObject({
      granted: false,
      refusalReason: override.REFUSAL.SECOND_APPROVER_UNKNOWN,
      predicateId: CLASS_C,
      constraintClass: "C",
      secondApproverId: NOBODY,
    });
  });

  test.each([["an arbitrary string", "ops-2"], ["an email address", "approver@robotx.test"], ["a name", "Shift Lead"]])(
    "a made-up non-user id (%s) is refused without querying the user table",
    async (_label, identity) => {
      const response = await assign({ secondApproverId: identity }).expect(403);
      refusedAndNotAssigned(response, override.REFUSAL.SECOND_APPROVER_UNKNOWN);
      expect(approverLookups()).toHaveLength(0);
    },
  );

  test("an approver whose role the policy does not admit is refused", async () => {
    mockPrismaClient.user.findUnique.mockImplementation(accounts(USER, { ...APPROVER, role: "VIEWER" }));
    const response = await assign({ secondApproverId: APPROVER.id }).expect(403);
    refusedAndNotAssigned(response, override.REFUSAL.SECOND_APPROVER_NOT_ELEVATED);
    expect(waiverAuditRow()).toMatchObject({ granted: false, refusalReason: override.REFUSAL.SECOND_APPROVER_NOT_ELEVATED });
  });

  test("the caller cannot be their own second approver", async () => {
    const response = await assign({ secondApproverId: USER.id }).expect(403);
    refusedAndNotAssigned(response, override.REFUSAL.SECOND_APPROVER_NOT_DISTINCT);
    expect(approverLookups()).toHaveLength(0);
  });

  test("a missing second approver is refused", async () => {
    const response = await assign({}).expect(403);
    refusedAndNotAssigned(response, override.REFUSAL.SECOND_APPROVER_REQUIRED);
    expect(approverLookups()).toHaveLength(0);
  });

  test("an unauthorised caller is refused at the route gate, before any approver lookup", async () => {
    mockPrismaClient.user.findUnique.mockImplementation(accounts(VIEWER, APPROVER));
    const response = await assign({ secondApproverId: APPROVER.id }).expect(403);
    expect(response.body.refusal).toBe(override.REFUSAL.ROLE_NOT_ELEVATED);
    expect(taskService.assignTask).not.toHaveBeenCalled();
    expect(approverLookups()).toHaveLength(0);
  });

  test("an approver lookup that fails refuses (503) and assigns nothing — an unverified approver is not an approver", async () => {
    mockPrismaClient.user.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === USER.id) return USER;
      throw new Error("database unavailable");
    });
    const response = await assign({ secondApproverId: APPROVER.id }).expect(503);
    refusedAndNotAssigned(response, override.REFUSAL.SECOND_APPROVER_UNVERIFIABLE);
    expect(waiverAuditRow()).toMatchObject({ granted: false, refusalReason: override.REFUSAL.SECOND_APPROVER_UNVERIFIABLE });
  });
});

describe("the contractual waiver rules are otherwise unchanged", () => {
  test("a class P waiver still needs no second approver, and none is looked up", async () => {
    await assign({ waivePredicate: CLASS_P }).expect(200);
    expect(taskService.assignTask).toHaveBeenCalledTimes(1);
    expect(approverLookups()).toHaveLength(0);
  });

  test("a class I predicate is still refused by name, even with a valid approver", async () => {
    const response = await assign({ waivePredicate: "F1", secondApproverId: APPROVER.id }).expect(403);
    expect(response.body.refusal).toBe(override.REFUSAL.CLASS_NOT_WAIVABLE);
    expect(taskService.assignTask).not.toHaveBeenCalled();
    expect(approverLookups()).toHaveLength(0);
  });

  test("an assignment that waives nothing is untouched by any of this", async () => {
    await request(app).post("/api/tasks/assign").set("Authorization", `Bearer ${token()}`).send({ taskId: "TSK-W-2" }).expect(200);
    expect(taskService.assignTask).toHaveBeenCalledTimes(1);
    expect(approverLookups()).toHaveLength(0);
  });
});
