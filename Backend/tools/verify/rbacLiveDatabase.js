"use strict";
/**
 * RBAC — live-PostgreSQL verification.
 *
 * The unit and socket suites run against stand-ins; these claims need PostgreSQL itself and
 * the real migration chain:
 *
 *   L1  the schema holds "ADMIN ⇔ exactly one campus, SUPER_ADMIN ⇔ none" (CHECK
 *       `User_role_campus_scope`), a row that names no role is not silently a platform
 *       administrator, and one region belongs to at most one campus;
 *   L2  `accessScope.robotWhere` / `taskWhere` select exactly the right rows from real data —
 *       including a robot whose agent region contradicts its campus, a task spanning two
 *       regions, a legacy task with no mission, and a campus with no region — and
 *       `campusIdForRobot` / `campusIdForTask` (the socket relay) agree with them;
 *   L3  provisioning: a SUPER_ADMIN's createAdmin writes the account and its audit event, the
 *       audit chain verifies, a duplicate is refused, and linking a region twice is refused;
 *   L4  over HTTP with the real app: an ADMIN signs in and sees only its campus; another
 *       campus's robot or task is a 404; it cannot reach SUPER_ADMIN surfaces; disabling it
 *       revokes its existing session at once.
 *
 * Usage (a disposable loopback database with the migrations applied — refused otherwise):
 *   DATABASE_URL=postgresql://user@127.0.0.1:55460/db node tools/verify/rbacLiveDatabase.js
 *
 * It writes only rows it creates, under codes prefixed `rbac-<pid>-`. Deliberately not a Jest
 * suite: a test that skips when its database is absent reports green for doing nothing.
 */

const { requireDisposableTarget } = require("../../src/config/environmentGuard");
const target = requireDisposableTarget();
if (target) {
  const port = new URL(process.env.DATABASE_URL.trim()).port || "5432";
  if (port === "5432") {
    console.error("[env] REFUSED: port 5432 is never a disposable target for this harness.");
    process.exit(78);
  }
}

process.env.JWT_SECRET = process.env.JWT_SECRET || require("crypto").randomBytes(32).toString("hex");
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const request = require("supertest");
const { getPrisma } = require("../../src/db/prisma");
const accessScope = require("../../src/services/accessScope.service");
const userAccount = require("../../src/services/userAccount.service");
const campusService = require("../../src/services/campus.service");
const auditStream = require("../../src/engine/observability/auditStream");
const { ensureAdminUser } = require("../../src/services/adminBootstrap.service");

const results = [];
function group(name) {
  console.log(`\n─── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`);
}
function check(label, ok, detail) {
  results.push({ label, ok: Boolean(ok) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `\n          ${detail}` : ""}`);
}
async function refused(promise, sqlState) {
  try {
    await promise;
    return { refused: false, detail: "write succeeded" };
  } catch (error) {
    const text = `${error.code || ""} ${error.message || ""}`;
    return { refused: sqlState ? text.includes(sqlState) || /violates check constraint|Unique constraint|23514|P2002/.test(text) : true, detail: text.slice(0, 200) };
  }
}

const RUN = `rbac-${process.pid}`;
const sorted = (rows, key) => rows.map((r) => r[key]).sort();

async function main() {
  const prisma = getPrisma();
  const quiet = { info() {}, warn() {} };

  // ── Fixture ────────────────────────────────────────────────────────────────
  const location = await prisma.location.create({ data: { name: `${RUN} area`, type: "AREA" } });
  const regionA = await prisma.region.create({ data: { regionId: `${RUN}-ra`, name: "A" } });
  const regionB = await prisma.region.create({ data: { regionId: `${RUN}-rb`, name: "B" } });
  const campusA = await prisma.campus.create({ data: { code: `${RUN}-A`, name: "Campus A", centerLat: 12.9, centerLon: 77.4, regionId: regionA.id } });
  const campusB = await prisma.campus.create({ data: { code: `${RUN}-B`, name: "Campus B", centerLat: 12.8, centerLon: 77.5, regionId: regionB.id } });
  const campusC = await prisma.campus.create({ data: { code: `${RUN}-C`, name: "Campus C (no region)", centerLat: 12.7, centerLon: 77.6 } });

  async function robot(code, campus, agentRegion) {
    const row = await prisma.robot.create({ data: { robotId: `${RUN}-${code}`, name: code, locationId: location.id, campusId: campus ? campus.id : null } });
    if (agentRegion !== undefined) {
      await prisma.agent.create({ data: { agentId: row.robotId, robotDbId: row.id, regionId: agentRegion ? agentRegion.id : null } });
    }
    return row;
  }
  const rA = await robot("R-A", campusA, regionA);
  const rA2 = await robot("R-A2", campusA, undefined); // no Agent row
  const rSplit = await robot("R-SPLIT", campusA, regionB); // campus A, agent region B
  const rB = await robot("R-B", campusB, null); // agent with no region
  await robot("R-NONE", null, undefined);

  async function task(code, { regions = [], robotRow = null } = {}) {
    const row = await prisma.task.create({ data: { taskId: `${RUN}-${code}`, pickup: "p", drop: "d", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2, robotId: robotRow ? robotRow.id : null } });
    for (const [index, region] of regions.entries()) {
      await prisma.mission.create({ data: { missionId: `${RUN}-${code}-m${index}`, regionId: region.id, tasks: { connect: { id: row.id } } } });
    }
    return row;
  }
  await task("T-A", { regions: [regionA] });
  await task("T-B", { regions: [regionB] });
  await task("T-MIX", { regions: [regionA, regionB] });
  await task("T-LEG-A", { robotRow: rA2 });
  await task("T-LEG-SPLIT", { robotRow: rSplit });
  await task("T-LEG-NONE");

  // ── L1 ─────────────────────────────────────────────────────────────────────
  group("L1 — the schema enforces the role/campus invariant");
  const bcryptHash = "$2b$10$0000000000000000000000000000000000000000000000000000";
  let r = await refused(prisma.user.create({ data: { email: `${RUN}-l1a@x.test`, password: bcryptHash, role: "ADMIN" } }), "23514");
  check("an ADMIN with no campus is refused by the database (CHECK)", r.refused, r.detail);
  r = await refused(prisma.user.create({ data: { email: `${RUN}-l1b@x.test`, password: bcryptHash, role: "SUPER_ADMIN", campusId: campusA.id } }), "23514");
  check("a SUPER_ADMIN with a campus is refused by the database (CHECK)", r.refused, r.detail);
  r = await refused(prisma.user.create({ data: { email: `${RUN}-l1c@x.test`, password: bcryptHash } }), "23514");
  check("a row that names no role is not created (default ADMIN, no campus → CHECK)", r.refused, r.detail);
  const okAdmin = await prisma.user.create({ data: { email: `${RUN}-l1d@x.test`, password: bcryptHash, role: "ADMIN", campusId: campusA.id } });
  check("an ADMIN with exactly one campus is stored (the enum holds ADMIN)", okAdmin.role === "ADMIN");
  r = await refused(prisma.user.update({ where: { id: okAdmin.id }, data: { campusId: null } }), "23514");
  check("an existing ADMIN cannot have its campus removed", r.refused, r.detail);
  r = await refused(prisma.campus.update({ where: { id: campusC.id }, data: { regionId: regionA.id } }), "P2002");
  check("a region already linked to one campus cannot be linked to another (unique)", r.refused, r.detail);
  r = await refused(prisma.campus.delete({ where: { id: campusA.id } }));
  check("a campus that still has administrators cannot be deleted (RESTRICT)", r.refused, r.detail);

  // ── L2 ─────────────────────────────────────────────────────────────────────
  group("L2 — scope filters on real rows, and the relay's resolution agrees");
  const scopeA = accessScope.accessScopeFor({ role: "ADMIN", campusId: campusA.id, campus: { ...campusA, region: { regionId: regionA.regionId } } });
  const scopeB = accessScope.accessScopeFor({ role: "ADMIN", campusId: campusB.id, campus: { ...campusB, region: { regionId: regionB.regionId } } });
  const scopeC = accessScope.accessScopeFor({ role: "ADMIN", campusId: campusC.id, campus: { ...campusC, region: null } });
  const scopeAll = accessScope.accessScopeFor({ role: "SUPER_ADMIN" });
  const mine = { robotId: { startsWith: RUN } };
  const myTasks = { taskId: { startsWith: RUN } };
  const robotsFor = async (scope) => sorted(await prisma.robot.findMany({ where: accessScope.within(mine, accessScope.robotWhere(scope)), select: { robotId: true } }), "robotId");
  const tasksFor = async (scope) => sorted(await prisma.task.findMany({ where: accessScope.within(myTasks, accessScope.taskWhere(scope)), select: { taskId: true } }), "taskId");
  const p = (codes) => codes.map((c) => `${RUN}-${c}`).sort();

  let got = await robotsFor(scopeA);
  check("campus A robots: R-A and R-A2 — not R-SPLIT (agent in region B), not R-B, not R-NONE", JSON.stringify(got) === JSON.stringify(p(["R-A", "R-A2"])), JSON.stringify(got));
  got = await robotsFor(scopeB);
  check("campus B robots: R-B only", JSON.stringify(got) === JSON.stringify(p(["R-B"])), JSON.stringify(got));
  got = await robotsFor(scopeC);
  check("campus C robots: none", got.length === 0, JSON.stringify(got));
  got = await robotsFor(scopeAll);
  check("SUPER_ADMIN robots: all five", got.length === 5, JSON.stringify(got));

  got = await tasksFor(scopeA);
  check("campus A tasks: T-A and T-LEG-A — not T-MIX (two regions), not T-LEG-SPLIT, not T-LEG-NONE", JSON.stringify(got) === JSON.stringify(p(["T-A", "T-LEG-A"])), JSON.stringify(got));
  got = await tasksFor(scopeB);
  check("campus B tasks: T-B only", JSON.stringify(got) === JSON.stringify(p(["T-B"])), JSON.stringify(got));
  got = await tasksFor(scopeC);
  check("campus C (no region) tasks: none", got.length === 0, JSON.stringify(got));
  got = await tasksFor(scopeAll);
  check("SUPER_ADMIN tasks: all six", got.length === 6, JSON.stringify(got));

  const robotCampus = {};
  for (const code of ["R-A", "R-A2", "R-SPLIT", "R-B", "R-NONE"]) robotCampus[code] = await accessScope.campusIdForRobot(prisma, `${RUN}-${code}`);
  check(
    "campusIdForRobot (the socket relay) agrees: R-A/R-A2 → A, R-B → B, R-SPLIT and R-NONE → none",
    robotCampus["R-A"] === campusA.id && robotCampus["R-A2"] === campusA.id && robotCampus["R-B"] === campusB.id && robotCampus["R-SPLIT"] === null && robotCampus["R-NONE"] === null,
    JSON.stringify(robotCampus),
  );
  check("campusIdForRobot resolves a robot by its row id as well", (await accessScope.campusIdForRobot(prisma, rA.id)) === campusA.id);
  const taskCampus = {};
  for (const code of ["T-A", "T-B", "T-MIX", "T-LEG-A", "T-LEG-SPLIT", "T-LEG-NONE"]) taskCampus[code] = await accessScope.campusIdForTask(prisma, `${RUN}-${code}`);
  check(
    "campusIdForTask agrees: T-A/T-LEG-A → A, T-B → B, T-MIX/T-LEG-SPLIT/T-LEG-NONE → none",
    taskCampus["T-A"] === campusA.id && taskCampus["T-LEG-A"] === campusA.id && taskCampus["T-B"] === campusB.id && taskCampus["T-MIX"] === null && taskCampus["T-LEG-SPLIT"] === null && taskCampus["T-LEG-NONE"] === null,
    JSON.stringify(taskCampus),
  );

  // ── L3 ─────────────────────────────────────────────────────────────────────
  group("L3 — provisioning and the campus → region link, with the audit stream");
  process.env.SEED_ADMIN_EMAIL = `${RUN}-root@x.test`;
  process.env.SEED_ADMIN_PASSWORD = `${RUN}-root-password`;
  delete process.env.SEED_ADMIN_RESET_PASSWORD;
  await ensureAdminUser(prisma, { logger: quiet });
  const root = await prisma.user.findUnique({ where: { email: process.env.SEED_ADMIN_EMAIL } });
  check("the bootstrap created the first SUPER_ADMIN, with no campus", root && root.role === "SUPER_ADMIN" && root.campusId === null);

  const adminPassword = `${RUN}-admin-password`;
  const created = await userAccount.createAdmin(prisma, { email: `${RUN}-admin@x.test`, password: adminPassword, campusId: campusA.id }, { id: root.id, role: root.role });
  const stored = await prisma.user.findUnique({ where: { id: created.id } });
  check("createAdmin stored an ADMIN of campus A, with a bcrypt hash (not the password)", stored.role === "ADMIN" && stored.campusId === campusA.id && stored.password !== adminPassword && /^\$2[aby]\$/.test(stored.password));
  const event = await prisma.auditEvent.findFirst({ where: { subjectType: "USER", subjectId: created.id } });
  check("its audit event names the SUPER_ADMIN who made it, and holds no password", event && event.actorId === root.id && event.payload.action === "ADMIN_CREATED" && !JSON.stringify(event.payload).includes(adminPassword));
  const chain = await auditStream.verifyStream({ prisma }, auditStream.GLOBAL_STREAM || "global", { expectedFirstSequence: 0 });
  check("the audit chain verifies end to end", chain.ok, JSON.stringify({ broken: chain.brokenLinks, gaps: chain.gaps }).slice(0, 200));
  let threw = null;
  try {
    await userAccount.createAdmin(prisma, { email: `${RUN}-ADMIN@x.test`, password: adminPassword, campusId: campusB.id }, { id: root.id, role: root.role });
  } catch (error) {
    threw = error;
  }
  check("a second account with the same email (any case) is refused with 409", threw && threw.status === 409);

  threw = null;
  try {
    await campusService.linkCampusRegion(prisma, campusC.id, regionA.regionId, { id: root.id, role: root.role });
  } catch (error) {
    threw = error;
  }
  check("linking campus C to campus A's region is refused (REGION_ALREADY_LINKED)", threw && threw.code === "REGION_ALREADY_LINKED");

  // ── L4 ─────────────────────────────────────────────────────────────────────
  group("L4 — over HTTP with the real app and the real database");
  const app = require("../../src/app");
  app.locals.prisma = prisma;
  const login = async (email, password) => {
    const response = await request(app).post("/api/auth/login").send({ email, password });
    return { status: response.status, cookie: response.headers["set-cookie"], body: response.body };
  };
  const adminSession = await login(`${RUN}-admin@x.test`, adminPassword);
  check("the ADMIN signs in; the response names its role and campus", adminSession.status === 200 && adminSession.body.user.role === "ADMIN" && adminSession.body.user.campus.id === campusA.id, JSON.stringify(adminSession.body));
  const asAdmin = (method, url) => request(app)[method](url).set("Cookie", adminSession.cookie);

  const robots = await asAdmin("get", "/api/robots");
  const listed = sorted(robots.body.robots.filter((x) => x.robotId.startsWith(RUN)), "robotId");
  check("GET /api/robots shows campus A's robots only", JSON.stringify(listed) === JSON.stringify(p(["R-A", "R-A2"])), JSON.stringify(listed));
  const forged = await asAdmin("get", `/api/robots?campusId=${campusB.id}`);
  check("…and naming campus B in the query returns nothing of campus B", forged.body.robots.every((x) => !x.robotId.startsWith(`${RUN}-R-B`)));
  const state = await asAdmin("get", "/api/robots/state");
  check("GET /api/robots/state shows campus A's robots only", sorted(state.body.robots.filter((x) => x.robotId.startsWith(RUN)), "robotId").join() === p(["R-A", "R-A2"]).join());
  const tasks = await asAdmin("get", "/api/tasks");
  check("GET /api/tasks shows campus A's tasks only", sorted(tasks.body.tasks.filter((x) => x.taskId.startsWith(RUN)), "taskId").join() === p(["T-A", "T-LEG-A"]).join());
  check("campus B's robot history is a 404", (await asAdmin("get", `/api/robots/${RUN}-R-B/history`)).status === 404);
  check("the split robot's history is a 404", (await asAdmin("get", `/api/robots/${RUN}-R-SPLIT/history`)).status === 404);
  check("campus A's robot history is readable", (await asAdmin("get", `/api/robots/${RUN}-R-A/history`)).status === 200);
  check("cancelling campus B's task is a 404, and it is not cancelled", (await asAdmin("post", `/api/tasks/${RUN}-T-B/cancel`)).status === 404 && (await prisma.task.findUnique({ where: { taskId: `${RUN}-T-B` } })).status !== "CANCELLED");
  check("creating an account as an ADMIN is a 403", (await asAdmin("post", "/api/users").send({ email: `${RUN}-x@x.test`, password: "long-enough-password", campusId: campusA.id })).status === 403);
  check("listing accounts as an ADMIN is a 403", (await asAdmin("get", "/api/users")).status === 403);
  check("GET /api/campuses lists only campus A", JSON.stringify((await asAdmin("get", "/api/campuses")).body.campuses.map((c) => c.id)) === JSON.stringify([campusA.id]));

  const rootSession = await login(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);
  const asRoot = (method, url) => request(app)[method](url).set("Cookie", rootSession.cookie);
  const all = sorted((await asRoot("get", "/api/robots")).body.robots.filter((x) => x.robotId.startsWith(RUN)), "robotId");
  check("a SUPER_ADMIN still sees every robot", all.length === 5, JSON.stringify(all));
  const mismatch = await asRoot("put", `/api/robots/${RUN}-R-SPLIT/campus`).send({ campusId: campusA.id });
  check("assigning a robot to a campus its agent's region contradicts is refused (409)", mismatch.status === 409 && String(mismatch.body.message).includes("region"), JSON.stringify(mismatch.body));
  const moved = await asRoot("put", `/api/robots/${RUN}-R-NONE/campus`).send({ campusId: campusB.id });
  check("a SUPER_ADMIN assigns an unassigned robot to campus B (audited)", moved.status === 200 && (await prisma.auditEvent.findFirst({ where: { subjectType: "ROBOT", subjectId: `${RUN}-R-NONE` } })) !== null);

  const disable = await asRoot("patch", `/api/users/${created.id}`).send({ disabled: true });
  check("the SUPER_ADMIN disables the ADMIN", disable.status === 200 && disable.body.user.disabled === true);
  check("the ADMIN's existing session is refused at once (401), with an unexpired token", (await asAdmin("get", "/api/robots")).status === 401);
  check("and it cannot sign in again (403)", (await login(`${RUN}-admin@x.test`, adminPassword)).status === 403);
  const revoked = await asAdmin("get", "/api/auth/me");
  check("its /api/auth/me says why: 401 ACCOUNT_DISABLED", revoked.status === 401 && revoked.body.code === "ACCOUNT_DISABLED", JSON.stringify(revoked.body));

  // ── L5 ───────────────────────────────────────────────────────────────────
  group("L5 — the account's own step-up PIN, on the real database");
  const pinUser = await userAccount.createAdmin(prisma, { email: `${RUN}-pin@x.test`, password: adminPassword, campusId: campusB.id }, { id: root.id, role: root.role });
  const pinSession = await login(`${RUN}-pin@x.test`, adminPassword);
  const asPinUser = (method, url) => request(app)[method](url).set("Cookie", pinSession.cookie).set("X-Forwarded-For", `10.9.${process.pid % 250}.1`);
  check("a newly created ADMIN has no PIN", (await asPinUser("get", "/api/auth/pin")).body.configured === false);
  check("so the step-up PIN check cannot pass (403 PIN not configured)", (await asPinUser("post", "/api/auth/pin-auth").send({ pin: "4821" })).status === 403);
  check("setting a PIN with a wrong password is refused, and nothing is stored",
    (await asPinUser("put", "/api/auth/pin").send({ currentPassword: "wrong-password", pin: "4821" })).status === 400 &&
      (await prisma.adminPinAuth.findUnique({ where: { userId: pinUser.id } })) === null);
  check("with the current password it is set", (await asPinUser("put", "/api/auth/pin").send({ currentPassword: adminPassword, pin: "4821" })).status === 200);
  const pinRow = await prisma.adminPinAuth.findUnique({ where: { userId: pinUser.id } });
  check("it is stored as a bcrypt hash, not the PIN", pinRow && pinRow.pinHash !== "4821" && /^\$2[aby]\$/.test(pinRow.pinHash));
  check("the step-up check now passes with it, and refuses a wrong one",
    (await asPinUser("post", "/api/auth/pin-auth").send({ pin: "4821" })).status === 200 &&
      (await asPinUser("post", "/api/auth/pin-auth").send({ pin: "0000" })).status === 401);
  const pinEvent = await prisma.auditEvent.findFirst({ where: { subjectType: "USER", subjectId: pinUser.id, actorId: pinUser.id } });
  check("the PIN change is on the audit stream, made by the account itself, with no PIN in it",
    pinEvent && pinEvent.payload.action === "STEP_UP_PIN_SET" && !JSON.stringify(pinEvent.payload).includes("4821"));
  check("an unauthenticated request cannot set a PIN", (await request(app).put("/api/auth/pin").send({ currentPassword: adminPassword, pin: "4821" })).status === 401);

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ""}`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
