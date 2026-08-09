"use strict";

/**
 * Engine lane — Phase 14: §23.4's authorisation applied at the REST surface.
 *
 * > Highest-privilege actions — quarantine override, safety-class config change, bulk
 * > cancellation, manual assignment against a Policy constraint — require elevated role
 * > plus a recorded reason, and where configured a second approver.
 *
 * Four actions, and this file accounts for all four: two are gated on live routes and
 * asserted here, one (`SAFETY_CONFIG_CHANGE`) is asserted in `configApi.test.js` where the
 * publish route lives, and one (`BULK_CANCELLATION`) has no endpoint — which is itself
 * asserted, because "we gated it" and "there is nothing to gate" are different statements
 * and only one of them is true.
 */

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const override = require("../../src/engine/security/override");
const { codeOnly } = require("../../src/engine/guards/sourceScan");

const sourceOf = (...segments) => codeOnly(fs.readFileSync(path.join(__dirname, "..", "..", "src", ...segments), "utf8"));

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  robot: { findUnique: jest.fn(), update: jest.fn() },
  event: { create: jest.fn() },
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

const app = require("../../src/app");

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "ops@robotx.test", role: "SUPER_ADMIN" };
const VIEWER = { ...USER, role: "VIEWER" };
const token = () => jwt.sign({ id: USER.id }, process.env.JWT_SECRET);

beforeEach(() => {
  mockPrismaClient.user.findUnique.mockResolvedValue(USER);
  mockPrismaClient.auditEvent.findFirst.mockResolvedValue(null);
  mockPrismaClient.auditEvent.create.mockImplementation(async ({ data }) => ({ ...data }));
  mockPrismaClient.overrideAudit.create.mockResolvedValue({});
  mockPrismaClient.robot.findUnique.mockResolvedValue({ id: "robot-db-1", status: "ERROR", currentTaskId: null });
  mockPrismaClient.robot.update.mockResolvedValue({});
  mockPrismaClient.event.create.mockResolvedValue({});
  app.locals.prisma = mockPrismaClient;
});

const clearFault = () => request(app).post("/api/robots/AGT-1/clear-fault").set("Authorization", `Bearer ${token()}`);

describe("§23.4 — QUARANTINE_OVERRIDE on the fault-recovery route", () => {
  test("it is refused with no recorded reason", async () => {
    const response = await clearFault().set("X-Second-Approver", "ops-2").send({}).expect(400);
    expect(response.body.refusal).toBe(override.REFUSAL.NO_REASON);
    expect(mockPrismaClient.robot.update).not.toHaveBeenCalled();
  });

  test("it is refused with no second approver — the class requires one by default", async () => {
    const response = await clearFault().set("X-Override-Reason", "battery replaced on site").send({}).expect(400);
    expect(response.body.refusal).toBe(override.REFUSAL.SECOND_APPROVER_REQUIRED);
  });

  test("it is refused for an unelevated role", async () => {
    mockPrismaClient.user.findUnique.mockResolvedValue(VIEWER);
    const response = await clearFault()
      .set("X-Override-Reason", "battery replaced on site")
      .set("X-Second-Approver", "ops-2")
      .send({})
      .expect(403);
    expect(response.body.refusal).toBe(override.REFUSAL.ROLE_NOT_ELEVATED);
  });

  test("with a reason and a distinct second approver it proceeds, and both audit records are written", async () => {
    await clearFault().set("X-Override-Reason", "battery replaced on site").set("X-Second-Approver", "ops-2").send({}).expect(200);

    expect(mockPrismaClient.auditEvent.create).toHaveBeenCalled();
    const audited = mockPrismaClient.auditEvent.create.mock.calls[0][0].data;
    expect(audited).toMatchObject({ eventType: "QUARANTINE", actorId: USER.id, reason: "battery replaced on site" });
    // The hash-chained event and the queryable row, joined by the hash.
    const row = mockPrismaClient.overrideAudit.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ granted: true, actionClass: "QUARANTINE_OVERRIDE", auditEventHash: audited.hash });
  });

  test("a REFUSED override is audited too", async () => {
    await clearFault().set("X-Second-Approver", "ops-2").send({}).expect(400);

    const row = mockPrismaClient.overrideAudit.create.mock.calls[0][0].data;
    // A stream holding only successes answers "nobody tried" to a question whose true
    // answer is "somebody tried eleven times".
    expect(row).toMatchObject({ granted: false, refusalReason: override.REFUSAL.NO_REASON });
  });

  test("the reason lands on the Event row an operator already has open", async () => {
    await clearFault().set("X-Override-Reason", "battery replaced on site").set("X-Second-Approver", "ops-2").send({}).expect(200);

    const message = mockPrismaClient.event.create.mock.calls[0][0].data.message;
    expect(message).toMatch(/battery replaced on site/);
    expect(message).toMatch(new RegExp(USER.id));
  });
});

describe("§7.2 — the fault-recovery route is not a predicate waiver", () => {
  test("a request asking to waive a class I predicate is refused by name, before anything else", async () => {
    const response = await clearFault()
      .set("X-Override-Reason", "the customer is waiting")
      .set("X-Second-Approver", "ops-2")
      .send({ waivePredicate: "F8" })
      .expect(403);

    expect(response.body.refusal).toBe(override.REFUSAL.CLASS_NOT_WAIVABLE);
    // The distinction the endpoint exists to keep: clearing a fault changes the agent's
    // observed state and the gate re-evaluates; waiving the predicate is a different act
    // and is not permitted to anyone.
    expect(response.body.note).toMatch(/the feasibility gate then re-evaluates against the new state/);
    expect(mockPrismaClient.robot.update).not.toHaveBeenCalled();
  });
});

describe("§23.4 — MANUAL_ASSIGNMENT_AGAINST_POLICY on the assign route", () => {
  test("an ordinary assignment is untouched by the gate", async () => {
    // The conditional shape matters: every request this endpoint receives today is an
    // ordinary assignment, and the gate must cost it nothing. The assertion is about the
    // *gate*, not about the request's eventual fate — the mocked store has no robots, so
    // the assignment itself fails, and asserting on its status would be asserting on the
    // legacy dispatcher rather than on §23.4.
    const response = await request(app)
      .post("/api/tasks/assign")
      .set("Authorization", `Bearer ${token()}`)
      .send({ pickup: "A", drop: "B" });

    expect(response.body.refusal).toBeUndefined();
    const gated = mockPrismaClient.overrideAudit.create.mock.calls.filter(
      (call) => call[0].data.actionClass === "MANUAL_ASSIGNMENT_AGAINST_POLICY",
    );
    expect(gated).toEqual([]);
  });

  test("a request naming an agent AND waiving a class I predicate is refused", async () => {
    const response = await request(app)
      .post("/api/tasks/assign")
      .set("Authorization", `Bearer ${token()}`)
      .set("X-Override-Reason", "operator judgement")
      .send({ pickup: "A", drop: "B", robotId: "AGT-1", waivePredicate: "F8", reason: "operator judgement" })
      .expect(403);

    expect(response.body.refusal).toBe(override.REFUSAL.CLASS_NOT_WAIVABLE);
    expect(response.body.constraintClass).toBe("I");
    expect(response.body.note).toMatch(/never to make an infeasible agent feasible/);
  });

  test("a waiver naming a predicate that does not exist is refused, not admitted", () => {
    // Through the module directly: an unknown predicate resolves to no class, and an
    // unknown class is refused outright. Unknown is never permission.
    const decision = override.authoriseWaiver(
      { predicateId: "F99", constraintClass: null, actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "r" },
      {},
    );
    expect(decision.refusal).toBe(override.REFUSAL.UNKNOWN_CLASS);
  });
});

describe("§23.4 — BULK_CANCELLATION has no endpoint to gate", () => {
  test("the action class is registered", () => {
    expect(override.ACTION_CLASS.BULK_CANCELLATION).toMatchObject({ elevated: true, reason: true });
  });

  test("no task route accepts a list of task ids", () => {
    // Inventing a bulk endpoint in order to gate it would be this phase adding a
    // capability rather than securing one. What is asserted instead is that none exists,
    // so a later phase adding one has to face this test.
    // Over the code, not the file: the routes file *documents* why bulk cancellation has
    // no endpoint, and a raw scan would match the sentence that explains the absence.
    const routes = sourceOf("routes", "tasks.routes.js");
    const controller = sourceOf("controllers", "tasks.controller.js");

    expect(routes).not.toMatch(/router\.post\("\/cancel"/);
    expect(routes).not.toMatch(/bulk/i);
    expect(controller).not.toMatch(/taskIds/);
  });
});

describe("§23.4 — the elevated-role list is one list", () => {
  test("no route file carries its own copy any more", () => {
    for (const file of ["config.routes.js", "shards.routes.js", "privacy.routes.js"]) {
      // Over the code: both files record in a comment that they *used to* carry the list,
      // which is the history a reviewer wants and which a raw scan would flag.
      const source = sourceOf("routes", file);
      // Two copies of an authorisation list is one copy that gets updated.
      expect({ file, hasLocalList: /ELEVATED_ROLES/.test(source) }).toEqual({ file, hasLocalList: false });
    }
  });

  test("the middleware resolves it from the register, and refuses when the role is absent", async () => {
    mockPrismaClient.user.findUnique.mockResolvedValue(VIEWER);
    await request(app).post("/api/privacy/erasure").set("Authorization", `Bearer ${token()}`).send({}).expect(403);
  });
});
