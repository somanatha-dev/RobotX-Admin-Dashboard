"use strict";

/**
 * RBAC — the HTTP capability matrix, enforced.
 *
 * 1. Default deny, structurally: every route registered under `/api` (discovered from the
 *    routers themselves, not from a list in this file) is called as a campus ADMIN. Only the
 *    routes in `ADMIN_CAPABLE` may answer with anything but a refusal, and a refused request
 *    writes nothing. A route added later without a gate fails here.
 * 2. The ADMIN-capable routes are scoped: lists carry the campus filter, a resource of another
 *    campus is the same 404 as an unknown one, and request-supplied roles, campuses, regions
 *    and shards change nothing.
 * 3. A SUPER_ADMIN keeps every route, unfiltered.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

// ── A Prisma stand-in that answers every read with "nothing" and records every write ──────
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const overrides = {};
const calls = [];
function modelProxy(model) {
  return new Proxy(
    {},
    {
      get(_target, method) {
        const key = `${model}.${String(method)}`;
        if (!overrides[key]) {
          overrides[key] = jest.fn(async () => {
            if (String(method) === "findMany") return [];
            if (String(method) === "count") return 0;
            if (String(method) === "groupBy") return [];
            return null;
          });
        }
        return (...args) => {
          calls.push({ model, method: String(method), args });
          return overrides[key](...args);
        };
      },
    },
  );
}
const mockPrisma = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "$transaction") return async (arg) => (typeof arg === "function" ? arg(mockPrisma) : Promise.all(arg));
      if (prop === "$queryRaw" || prop === "$executeRaw" || prop === "$queryRawUnsafe") return async () => [];
      if (prop === "then") return undefined;
      return modelProxy(String(prop));
    },
  },
);

jest.mock("../../../src/db/prisma", () => ({
  getPrisma: () => mockPrisma,
  connectPrisma: jest.fn(),
  connectPrismaWithRetry: jest.fn(),
  disconnectPrisma: jest.fn(),
  runSerializable: jest.fn(async (prisma, fn) => fn(prisma)),
  selectForUpdate: jest.fn(async () => []),
  isSerializationFailure: () => false,
}));

const apiRoutes = require("../../../src/routes");
const accessScope = require("../../../src/services/accessScope.service");

const CAMPUS_A = { id: "c0a00000-0000-4000-8000-00000000000a", code: "RNSIT", name: "RNS Institute of Technology", regionId: "r0a00000-0000-4000-8000-00000000000a", region: { regionId: "rnsit" } };
const CAMPUS_NO_REGION = { id: "c0b00000-0000-4000-8000-00000000000b", code: "jssate-bengaluru", name: "JSS Academy", regionId: null, region: null };

const SUPER = { id: "11111111-1111-4111-8111-111111111111", email: "root@robotx.test", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null };
const ADMIN = { id: "22222222-2222-4222-8222-222222222222", email: "a@robotx.test", role: "ADMIN", campusId: CAMPUS_A.id, campus: CAMPUS_A, disabledAt: null };
const ADMIN_NO_REGION = { ...ADMIN, id: "33333333-3333-4333-8333-333333333333", campusId: CAMPUS_NO_REGION.id, campus: CAMPUS_NO_REGION };
const ADMIN_BROKEN = { ...ADMIN, id: "44444444-4444-4444-8444-444444444444", campusId: CAMPUS_A.id, campus: null };
const DISABLED = { ...ADMIN, id: "55555555-5555-4555-8555-555555555555", disabledAt: new Date() };
const ACCOUNTS = [SUPER, ADMIN, ADMIN_NO_REGION, ADMIN_BROKEN, DISABLED];

const tokenFor = (user, claims = {}) => `Bearer ${jwt.sign({ id: user.id, ...claims }, process.env.JWT_SECRET)}`;

const app = express();
app.use(express.json());
app.use("/api", apiRoutes);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ ok: false, error: err.message }));
app.locals.prisma = mockPrisma;

/** The routes an ADMIN may reach at all — the HTTP half of the capability matrix. */
const ADMIN_CAPABLE = new Set([
  "GET /api/robots",
  "GET /api/robots/state",
  "GET /api/robots/:robotId/history",
  "POST /api/robots/:robotId/command",
  "GET /api/tasks",
  "POST /api/tasks/assign",
  "POST /api/tasks/:taskId/cancel",
  "GET /api/explain/task/:taskId",
  "GET /api/campuses",
]);
/** The caller's own account and session — open to every signed-in account by design. */
const OWN_ACCOUNT_PREFIX = "/api/auth/";

/** Every `METHOD /api/<mount><path>` the API serves, read from the routers themselves. */
function discoverRoutes() {
  const indexSource = fs.readFileSync(path.join(__dirname, "../../../src/routes/index.js"), "utf8");
  const files = {};
  for (const m of indexSource.matchAll(/const (\w+)\s*=\s*require\("\.\/([\w.]+)"\)/g)) files[m[1]] = m[2];
  const routes = [];
  for (const m of indexSource.matchAll(/router\.use\("(\/[\w-]+)",\s*(\w+)\)/g)) {
    const router = require(path.join(__dirname, "../../../src/routes", files[m[2]]));
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), template: `/api${m[1]}${layer.route.path === "/" ? "" : layer.route.path}` });
      }
    }
  }
  return routes;
}

function concrete(template) {
  return template
    .replace(":robotId", "R-ELSEWHERE")
    .replace(":taskId", "T-ELSEWHERE")
    .replace(":id", "99999999-9999-4999-8999-999999999999")
    .replace(/:\w+/g, "x");
}

function send(method, url, user, body) {
  const call = request(app)[method.toLowerCase()](url).set("Authorization", tokenFor(user));
  return method === "GET" ? call : call.send(body || {});
}

beforeEach(() => {
  for (const key of Object.keys(overrides)) delete overrides[key];
  calls.length = 0;
  overrides["user.findUnique"] = jest.fn(async ({ where }) => ACCOUNTS.find((u) => u.id === where.id) || null);
});

const writes = () => calls.filter((c) => WRITE_METHODS.has(c.method) && c.model !== "auditEvent");

describe("RBAC — default deny over every /api route", () => {
  const routes = discoverRoutes();

  test("the route table was discovered (guards against a vacuous pass)", () => {
    expect(routes.length).toBeGreaterThan(40);
    for (const capable of ADMIN_CAPABLE) expect(routes.map((r) => `${r.method} ${r.template}`)).toContain(capable);
  });

  test.each(routes.filter((r) => !ADMIN_CAPABLE.has(`${r.method} ${r.template}`) && !r.template.startsWith(OWN_ACCOUNT_PREFIX)).map((r) => [`${r.method} ${r.template}`, r]))(
    "%s is refused to a campus ADMIN, and nothing is written",
    async (_label, route) => {
      const response = await send(route.method, concrete(route.template), ADMIN, { reason: "r", secondApproverId: SUPER.id, campusId: CAMPUS_A.id, role: "SUPER_ADMIN" });
      expect([403, 404]).toContain(response.status);
      expect(writes()).toEqual([]);
    },
  );

  test.each([...ADMIN_CAPABLE].map((r) => [r]))("%s refuses an ADMIN whose campus does not resolve (fails closed)", async (route) => {
    const [method, template] = route.split(" ");
    const response = await send(method, concrete(template), ADMIN_BROKEN, { type: "STOP" });
    expect(response.status).toBe(403);
    expect(writes()).toEqual([]);
  });

  test("a disabled account is unauthenticated everywhere, with an unexpired token", async () => {
    await send("GET", "/api/robots", DISABLED).expect(401);
    await send("GET", "/api/auth/me", DISABLED).expect(401);
  });

  test("a role claim in the token, or in the body, grants nothing", async () => {
    const forged = request(app).post("/api/users").set("Authorization", tokenFor(ADMIN, { role: "SUPER_ADMIN" }));
    await forged.send({ email: "x@robotx.test", password: "a-long-enough-password", campusId: CAMPUS_A.id, role: "SUPER_ADMIN" }).expect(403);
    await send("GET", "/api/simulator/status", ADMIN, { role: "SUPER_ADMIN" }).expect(403);
    expect(writes()).toEqual([]);
  });

  test("a request with no identity is 401 on every ADMIN-capable route", async () => {
    for (const route of ADMIN_CAPABLE) {
      const [method, template] = route.split(" ");
      const response = await request(app)[method.toLowerCase()](concrete(template)).send({});
      expect(response.status).toBe(401);
    }
  });
});

describe("RBAC — ADMIN-capable routes are scoped to the caller's campus", () => {
  test("GET /api/robots filters by the ADMIN's campus, whatever campusId the query names", async () => {
    await send("GET", `/api/robots?campusId=${CAMPUS_NO_REGION.id}`, ADMIN).expect(200);
    const [{ where }] = calls.find((c) => c.model === "robot" && c.method === "findMany").args;
    expect(where.AND).toContainEqual(accessScope.robotWhere(accessScope.accessScopeFor(ADMIN)));
    expect(JSON.stringify(where)).toContain(CAMPUS_A.id);
  });

  test("GET /api/robots/state and GET /api/tasks carry the campus filter", async () => {
    await send("GET", "/api/robots/state", ADMIN).expect(200);
    await send("GET", "/api/tasks", ADMIN).expect(200);
    const robotWhere = calls.find((c) => c.model === "robot" && c.method === "findMany").args[0].where;
    const taskWhere = calls.find((c) => c.model === "task" && c.method === "findMany").args[0].where;
    expect(JSON.stringify(robotWhere)).toContain(CAMPUS_A.id);
    expect(JSON.stringify(taskWhere)).toContain(CAMPUS_A.regionId);
  });

  test("a SUPER_ADMIN's lists are not narrowed", async () => {
    await send("GET", "/api/robots", SUPER).expect(200);
    await send("GET", "/api/tasks", SUPER).expect(200);
    const robotWhere = calls.find((c) => c.model === "robot" && c.method === "findMany").args[0].where;
    const taskWhere = calls.find((c) => c.model === "task" && c.method === "findMany").args[0].where;
    expect(JSON.stringify(robotWhere)).not.toContain(CAMPUS_A.id);
    expect(taskWhere.AND).toBeUndefined();
  });

  test("a robot of another campus is the same 404 as an unknown one, before anything is read or written", async () => {
    const other = await send("POST", "/api/robots/R-ELSEWHERE/command", ADMIN, { type: "STOP" }).expect(404);
    const unknown = await send("POST", "/api/robots/NO-SUCH-ROBOT/command", ADMIN, { type: "STOP" }).expect(404);
    expect(other.body).toEqual(unknown.body);
    const [{ where }] = calls.find((c) => c.model === "robot" && c.method === "findFirst").args;
    expect(JSON.stringify(where)).toContain(CAMPUS_A.id);
    expect(writes()).toEqual([]);
    await send("GET", "/api/robots/R-ELSEWHERE/history", ADMIN).expect(404);
  });

  test("a task of another campus is the same 404 as an unknown one (cancel, explain)", async () => {
    const cancel = await send("POST", "/api/tasks/T-ELSEWHERE/cancel", ADMIN).expect(404);
    const explain = await send("GET", "/api/explain/task/T-ELSEWHERE", ADMIN).expect(404);
    expect(cancel.body).toEqual({ ok: false, error: "Unknown taskId", message: "Unknown taskId" });
    expect(explain.body).toEqual(cancel.body);
    expect(writes()).toEqual([]);
  });

  test("in its campus, an ADMIN may STOP or PAUSE; RESUME and RETURN are refused before a Command row exists", async () => {
    overrides["robot.findFirst"] = jest.fn(async () => ({ id: "db-1", robotId: "R-HERE" }));
    for (const type of ["RESUME", "RETURN"]) {
      const response = await send("POST", "/api/robots/R-HERE/command", ADMIN, { type }).expect(403);
      expect(response.body.error).toMatch(/reserved for a super administrator/);
    }
    expect(calls.filter((c) => c.model === "command" && c.method === "create")).toEqual([]);
  });

  test("an ADMIN's task goes to its campus's region; another region, a shard, or no region is refused", async () => {
    const body = { pickup: "A", drop: "B", pickupLat: 12.9, pickupLon: 77.4, dropLat: 12.91, dropLon: 77.41 };
    const other = await send("POST", "/api/tasks/assign", ADMIN, { ...body, regionId: "some-other-region" }).expect(403);
    expect(other.body.error).toMatch(/own campus's operating region/);
    await send("POST", "/api/tasks/assign?regionId=some-other-region", ADMIN, body).expect(403);
    await send("POST", "/api/tasks/assign", ADMIN, { ...body, shardId: "s-elsewhere" }).expect(403);
    const none = await send("POST", "/api/tasks/assign", ADMIN_NO_REGION, body).expect(409);
    expect(none.body.error).toMatch(/no operating region/);
    expect(writes()).toEqual([]);
  });

  // An Idempotency-Key is global, so a replayed key answers with the task first accepted under
  // it — whichever campus submitted that. A crafted replay of another campus's key must not
  // name that task to an ADMIN; the same replay of its own task still answers normally.
  test("an Idempotency-Key that resolves to another campus's task is refused to an ADMIN, and names no task", async () => {
    const taskService = require("../../../src/services/task.service");
    const spy = jest.spyOn(taskService, "assignTask");
    try {
      const body = { pickup: "A", drop: "B", pickupLat: 12.9, pickupLon: 77.4, dropLat: 12.91, dropLon: 77.41 };
      const replay = (key) =>
        request(app).post("/api/tasks/assign").set("Authorization", tokenFor(ADMIN)).set("Idempotency-Key", key).send(body);

      spy.mockResolvedValueOnce({ taskId: "T-OTHER-CAMPUS", status: "PENDING", persisted: true, intake: { accepted: true } });
      overrides["task.findFirst"] = jest.fn(async () => null); // not in campus A's task scope
      const foreign = await replay("key-of-campus-b").expect(409);
      expect(foreign.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
      expect(JSON.stringify(foreign.body)).not.toContain("T-OTHER-CAMPUS");
      // The submission itself was pinned to the ADMIN's region, whatever the body said.
      expect(spy.mock.calls[0][2]).toMatchObject({ regionId: "rnsit", shardId: null, idempotencyKey: "key-of-campus-b" });

      spy.mockResolvedValueOnce({ taskId: "T-OWN", status: "PENDING", persisted: true, intake: { accepted: true } });
      overrides["task.findFirst"] = jest.fn(async () => ({ id: "row-own", taskId: "T-OWN" }));
      const own = await replay("key-of-campus-a");
      expect(own.status).not.toBe(409);
      expect(own.status).toBeLessThan(300);
      expect(JSON.stringify(own.body)).toContain("T-OWN");
    } finally {
      spy.mockRestore();
    }
  });

  test("a waiver is refused to an ADMIN by the §23.4 gate, and the refusal is audited", async () => {
    const response = await send("POST", "/api/tasks/assign", ADMIN, { waivePredicate: "F9", reason: "r" }).expect(403);
    expect(response.body.refusal).toBe("ROLE_NOT_ELEVATED");
    expect(calls.some((c) => c.model === "overrideAudit" && c.method === "create")).toBe(true);
  });

  test("GET /api/campuses lists only the ADMIN's own campus", async () => {
    await send("GET", "/api/campuses", ADMIN).expect(200);
    const [{ where }] = calls.find((c) => c.model === "campus" && c.method === "findMany").args;
    expect(where).toEqual({ id: CAMPUS_A.id });
  });

  test("a refused mutating request on a SUPER_ADMIN surface is appended to the audit stream", async () => {
    await send("POST", "/api/campuses", ADMIN, { code: "X", name: "X", centerLat: 1, centerLon: 1 }).expect(403);
    await new Promise((resolve) => setImmediate(resolve));
    const appended = calls.filter((c) => c.model === "auditEvent" && c.method === "create").map((c) => c.args[0].data);
    expect(appended).toContainEqual(expect.objectContaining({ actorId: ADMIN.id, actorRole: "ADMIN", subjectType: "ROUTE", subjectId: "/api/campuses/" }));
  });
});

describe("RBAC — /api/auth/me reports the account's own scope", () => {
  test("an ADMIN sees its campus; a SUPER_ADMIN has none; nothing secret is returned", async () => {
    const admin = await send("GET", "/api/auth/me", ADMIN).expect(200);
    expect(admin.body.user).toEqual({ id: ADMIN.id, email: ADMIN.email, role: "ADMIN", campus: { id: CAMPUS_A.id, code: "RNSIT", name: CAMPUS_A.name, regionId: "rnsit" } });
    const root = await send("GET", "/api/auth/me", SUPER).expect(200);
    expect(root.body.user.campus).toBeNull();
    expect(JSON.stringify(admin.body)).not.toMatch(/password/i);
  });
});
