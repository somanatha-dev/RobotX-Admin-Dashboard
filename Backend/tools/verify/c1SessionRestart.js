#!/usr/bin/env node
"use strict";

/**
 * C1 live proof — a paired physical robot's session survives a real backend process restart.
 *
 *   node tools/verify/c1SessionRestart.js --database-url postgresql://<user>@127.0.0.1:<port>/<db> [--port 3051]
 *
 * Against a DISPOSABLE local database only (refused otherwise), with REDIS_ENABLED=false — the
 * deployment in which the KV is process memory and a session token used to die with the process
 * (LAN-3). The backend is the real `server.js`, started as a child process through the V1
 * launcher, killed, and started again on the same database: four processes in all. Nothing is
 * cleared in-process and nothing is mocked; the robot side is a Socket.IO client speaking the
 * Pi's AUTH contract (`AUTH {robotId, token}` / `AUTH {robotId, pairingCode}` → `AUTH_SUCCESS
 * {token}`, a refusal is a server disconnect).
 *
 *   process 1  pair with a fresh code → token T; reconnect with T; replay the consumed code;
 *              two sockets presenting T (duplicate AUTH); the durable row is read and checked to
 *              hold no raw token
 *   ── kill ──
 *   process 2  reconnect with T (must succeed, no pairing); a forged token and another robot
 *              presenting T are refused; five more valid reconnects, then a freshly minted code
 *              still pairs (so no valid reconnect counted as a failure) → token T2
 *   ── kill ──
 *   process 3  T is refused (the re-pairing revoked it, durably); T2 succeeds; wrong codes lock
 *              pairing and a correct fresh code is then refused; T2 still reconnects under the
 *              lockout (the lockout gates pairing only, as before); R2: with T2's socket open
 *              and heartbeating, its durable row (clock-shifted to 20 s from lapsing) is slid a
 *              full lifetime ahead
 *   ── kill ──
 *   process 4  R2: T2, whose original expiry passed while it was connected, reconnects through
 *              the durable session; T2 refused once its durable expiry has passed
 *
 * When process 2 refuses T, the harness instead walks what the Pi then does (discard the token,
 * fall back to its configured — already consumed — pairing code) until the lockout, records it as
 * LAN-3 REPRODUCED and exits 1. Exit 0 = C1 PASS.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const BACKEND = path.resolve(__dirname, "..", "..");
const { assertDisposableLocal } = require(path.join(BACKEND, "tools/demo/disposableDatabase"));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = assertDisposableLocal(flag("--database-url", ""), { purpose: "the C1 session restart proof" });
const PORT = Number(flag("--port", "3051"));
const BASE = `http://127.0.0.1:${PORT}`;
const ROBOT_ID = "robotx-pi-c1";
const OTHER_ROBOT_ID = "robotx-pi-c1-other";
const ADMIN = { email: "c1-admin@localhost", password: "C1-Disposable-Passw0rd!" };
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "c1-"));

process.env.DATABASE_URL = url;
process.env.DATABASE_URL_LOCAL = url;
process.env.REDIS_ENABLED = "false";
process.env.REDIS_URL = "";

const log = (...args) => console.log("[c1]", ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

/* ── the backend process ─────────────────────────────────────────────────── */
let serverIndex = 0;
async function startServer() {
  serverIndex += 1;
  const logFile = path.join(SCRATCH, `server-${serverIndex}.log`);
  const out = fs.createWriteStream(logFile);
  const child = spawn(process.execPath, [path.join(BACKEND, "tools/demo/startV1Server.js"), "--database-url", url, "--port", String(PORT), "--host", "127.0.0.1"], {
    cwd: BACKEND,
    env: { ...process.env, SEED_ADMIN_EMAIL: ADMIN.email, SEED_ADMIN_PASSWORD: ADMIN.password },
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status < 500) {
        log(`server ${serverIndex} up: pid ${child.pid}, log ${logFile}`);
        return { child, exited, logFile, pid: child.pid };
      }
    } catch { /* not yet */ }
    if (child.exitCode !== null) break;
    await sleep(1000);
  }
  throw new Error(`server ${serverIndex} never became healthy; see ${logFile}`);
}

async function killServer(server) {
  server.child.kill("SIGKILL"); // TerminateProcess on Windows: no shutdown hook runs
  const how = await server.exited;
  let refused = false;
  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    refused = true;
  }
  log(`server pid ${server.pid} terminated (${JSON.stringify(how)}); port ${PORT} refusing: ${refused}`);
  return { ...how, refused };
}

async function operator() {
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ADMIN) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (!login.ok || !cookie) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  return {
    async mintPairingCode(robotId) {
      const r = await fetch(`${BASE}/api/robots/commission`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ robotId }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.pairingCode) throw new Error(`commission failed: ${r.status} ${JSON.stringify(json)}`);
      return String(json.pairingCode);
    },
  };
}

/* ── the robot side: the Pi's AUTH contract ──────────────────────────────── */
const { io: ioClient } = require(path.join(BACKEND, "node_modules/socket.io-client"));

/**
 * One AUTH on a fresh socket. Resolves `{ ok: true, token, mode, socket }` on AUTH_SUCCESS (the
 * socket left open when `keepOpen`), or `{ ok: false, reason }` when the server disconnects it.
 */
function auth(credential, { keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const socket = ioClient(BASE, { transports: ["websocket"], reconnection: false, forceNew: true });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!keepOpen || !result.ok) socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), 8000);
    let authFailed = null; // R1 — the explicit refusal, when the server sent one before disconnecting
    socket.on("connect", () => socket.emit("AUTH", credential));
    socket.on("AUTH_SUCCESS", (ack) => done({ ok: true, token: ack && ack.token, mode: ack && ack.session && ack.session.mode, socket }));
    socket.on("AUTH_FAILED", (payload) => {
      authFailed = payload;
    });
    socket.on("disconnect", (reason) => done({ ok: false, reason, authFailed }));
    socket.on("connect_error", (e) => done({ ok: false, reason: `connect_error ${e && e.message}` }));
  });
}

function authLogLines(logFile) {
  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/u)
    .filter((l) => /Robot AUTH success|Pairing rejected|Pairing brute-force|robot locked out/u.test(l));
}

async function sessionRow(prisma, robotDbId) {
  if (!prisma.robotSession) return { modelPresent: false };
  const row = await prisma.robotSession.findUnique({ where: { robotDbId } });
  return { modelPresent: true, row };
}

async function main() {
  /* seed + commission two physical units on a fresh database */
  log("seeding the V1 world");
  const seeded = spawnSync(process.execPath, [path.join(BACKEND, "tools/demo/seedV1Demonstration.js"), "--database-url", url, "--fleet", "single"], {
    cwd: BACKEND,
    env: process.env,
    encoding: "utf8",
  });
  if (seeded.status !== 0) throw new Error(`seed failed:\n${seeded.stdout}\n${seeded.stderr}`);

  const { getPrisma } = require(path.join(BACKEND, "src/db/prisma"));
  const prisma = getPrisma();
  const robotService = require(path.join(BACKEND, "src/services/robot.service"));
  const robotSpecification = require(path.join(BACKEND, "src/services/robotSpecification"));
  const location = await prisma.location.findFirst();
  for (const robotCode of [ROBOT_ID, OTHER_ROBOT_ID]) {
    await robotService.createRobotWithProjection(
      prisma,
      {
        locationId: location.id,
        name: `C1 physical unit ${robotCode}`,
        chassisType: robotSpecification.CHASSIS_TYPE.ROVER,
        // Gate 1's declaration; a harness input on a throwaway database, not a fleet fact.
        specification: { massKg: 5, maxSpeedMps: 1.2, normalSpeedMps: 1.0, batteryCapacityWh: 43, batteryReservePct: 20, payloadCapacityKg: 3, initialBatteryPct: 85 },
      },
      { robotCode, simulated: false, simulationOwnerId: null },
    );
  }
  const robotRow = await prisma.robot.findUnique({ where: { robotId: ROBOT_ID }, select: { id: true } });

  /* ── process 1 ─────────────────────────────────────────────────────────── */
  let server = await startServer();
  let ops = await operator();
  const code1 = await ops.mintPairingCode(ROBOT_ID);

  const paired = await auth({ robotId: ROBOT_ID, pairingCode: code1 });
  check("P1 first pairing with a fresh code succeeds and returns a session token", paired.ok && typeof paired.token === "string" && paired.token.length > 0, { ok: paired.ok, mode: paired.mode, reason: paired.reason });
  const T = paired.token;

  const again = await auth({ robotId: ROBOT_ID, token: T });
  check("P1 reconnect with the session token (no restart) succeeds and returns the same token", again.ok && again.token === T, { ok: again.ok, sameToken: again.token === T });

  const replayCode = await auth({ robotId: ROBOT_ID, pairingCode: code1 });
  check("P1 the consumed pairing code replayed is refused (single use)", !replayCode.ok, replayCode.reason);

  const first = await auth({ robotId: ROBOT_ID, token: T }, { keepOpen: true });
  const firstClosed = first.ok ? new Promise((resolve) => first.socket.once("disconnect", (r) => resolve(r))) : Promise.resolve("not-open");
  const second = await auth({ robotId: ROBOT_ID, token: T }, { keepOpen: true });
  const firstOutcome = await Promise.race([firstClosed, sleep(3000).then(() => "still-open")]);
  check("P1 duplicate AUTH with the same token: both admitted, the earlier socket replaced", first.ok && second.ok && firstOutcome === "io server disconnect", { first: first.ok, second: second.ok, firstOutcome });
  // Y1 — the replaced socket's disconnect has now run server-side; it must not have taken the
  // robot offline, because the row's socket is the second one.
  await sleep(1000);
  const afterReplacement = await prisma.robot.findUnique({ where: { robotId: ROBOT_ID }, select: { isOnline: true, status: true, socketId: true } });
  check("P1 Y1: after the replaced socket disconnected, the robot is still online on the second socket", afterReplacement.isOnline === true && afterReplacement.status !== "OFFLINE" && afterReplacement.socketId === (second.socket && second.socket.id), {
    row: afterReplacement,
    secondSocket: second.socket && second.socket.id,
  });
  if (second.socket) second.socket.close();

  const durable1 = await sessionRow(prisma, robotRow.id);
  log("durable session row after pairing:", JSON.stringify(durable1));
  if (durable1.modelPresent) {
    const values = durable1.row ? Object.values(durable1.row).map(String) : [];
    check("P1 the durable row holds sha256(T), never T itself", durable1.row && durable1.row.tokenHash === sha256(T) && !values.some((v) => v.includes(T)), {
      tokenHashMatches: durable1.row && durable1.row.tokenHash === sha256(T),
      rawTokenAnywhere: values.some((v) => v.includes(T)),
    });
  } else {
    log("no RobotSession model in this build — the session exists only in the process's KV");
  }
  const killed1 = await killServer(server);
  check("process 1 is dead and the port refuses connections", killed1.refused, killed1);
  const log1 = server.logFile;

  /* ── process 2 ─────────────────────────────────────────────────────────── */
  server = await startServer();
  ops = await operator();

  const afterRestart = await auth({ robotId: ROBOT_ID, token: T });
  check("P2 reconnect with T after a process restart succeeds, same token, no pairing", afterRestart.ok && afterRestart.token === T, { ok: afterRestart.ok, reason: afterRestart.reason, authFailed: afterRestart.authFailed });

  if (!afterRestart.ok) {
    // What the Pi does next (backend_link.py: a refused token is discarded; the configured
    // pairing code — consumed at the first pairing — is presented instead), until locked.
    log("LAN-3: the token was refused after restart; walking the Pi's fallback");
    const attempts = [];
    for (let i = 0; i < 5; i += 1) attempts.push((await auth({ robotId: ROBOT_ID, pairingCode: code1 })).ok);
    const fresh = await ops.mintPairingCode(ROBOT_ID);
    const freshCode = await auth({ robotId: ROBOT_ID, pairingCode: fresh });
    log("pairing fallback with the consumed code, 5 attempts:", JSON.stringify(attempts));
    log("a freshly minted, correct pairing code after that:", freshCode.ok ? "ACCEPTED" : `REFUSED (${freshCode.reason}) — locked out`);
    log("server 2 AUTH log:\n  " + authLogLines(server.logFile).join("\n  "));
    check("LAN-3 REPRODUCED: restart stranded the paired robot and pushed it into the pairing lockout", false, {
      tokenRefusedAfterRestart: true,
      consumedCodeAttempts: attempts,
      freshCorrectCodeAfterwards: freshCode.ok ? "accepted" : "refused (locked)",
    });
    await killServer(server);
    await prisma.$disconnect();
    return finish();
  }

  const forged = await auth({ robotId: ROBOT_ID, token: crypto.randomUUID() });
  check("P2 a forged token for the paired robot is refused after restart", !forged.ok, forged.reason);
  const otherRobot = await auth({ robotId: OTHER_ROBOT_ID, token: T });
  check("P2 T presented as another robot is refused (identity-bound)", !otherRobot.ok, otherRobot.reason);
  // R1 — over a real Socket.IO transport, the explicit refusal arrives before the server's
  // disconnect, and carries the reason alone.
  const exactlyInvalid = (r) => !r.ok && r.authFailed && JSON.stringify(r.authFailed) === JSON.stringify({ reason: "INVALID_CREDENTIAL" });
  check("P2 R1: the forged token's refusal arrived as AUTH_FAILED {reason: INVALID_CREDENTIAL} before the disconnect", exactlyInvalid(forged), forged.authFailed);
  check("P2 R1: T presented as another robot got the same AUTH_FAILED", exactlyInvalid(otherRobot), otherRobot.authFailed);
  const unknownRobot = await auth({ robotId: "robotx-not-commissioned", token: T });
  check("P2 R1: an uncommissioned robotId gets the identical AUTH_FAILED (no robot-id oracle)", exactlyInvalid(unknownRobot), unknownRobot.authFailed);

  const valids = [];
  for (let i = 0; i < 5; i += 1) valids.push((await auth({ robotId: ROBOT_ID, token: T })).ok);
  check("P2 five further valid reconnects all succeed", valids.every(Boolean), valids);
  const code2 = await ops.mintPairingCode(ROBOT_ID);
  const repaired = await auth({ robotId: ROBOT_ID, pairingCode: code2 });
  check("P2 after 1 refusal + 6 valid reconnects a fresh code still pairs (valid reconnects counted no failure)", repaired.ok && repaired.token && repaired.token !== T, { ok: repaired.ok, reason: repaired.reason });
  const T2 = repaired.token;
  const oldInSameProcess = await auth({ robotId: ROBOT_ID, token: T });
  check("P2 re-pairing revoked T in the same process", !oldInSameProcess.ok, oldInSameProcess.reason);
  const durable2 = await sessionRow(prisma, robotRow.id);
  check("P2 the durable row now holds sha256(T2)", durable2.row && durable2.row.tokenHash === sha256(T2), durable2.row && { expiresAt: durable2.row.expiresAt });
  const log2 = server.logFile;
  const killed2 = await killServer(server);
  check("process 2 is dead and the port refuses connections", killed2.refused, killed2);

  /* ── process 3 ─────────────────────────────────────────────────────────── */
  server = await startServer();
  ops = await operator();

  const revoked = await auth({ robotId: ROBOT_ID, token: T });
  check("P3 the revoked token T stays refused across a restart", !revoked.ok, revoked.reason);
  const t2 = await auth({ robotId: ROBOT_ID, token: T2 });
  check("P3 T2 reconnects after a second restart", t2.ok && t2.token === T2, { ok: t2.ok, reason: t2.reason });

  // Lockout: the T refusal above is attempt 1 in this process; four wrong codes make five.
  const wrong = [];
  for (let i = 0; i < 4; i += 1) wrong.push((await auth({ robotId: ROBOT_ID, pairingCode: "000000" })).ok);
  const code3 = await ops.mintPairingCode(ROBOT_ID);
  const locked = await auth({ robotId: ROBOT_ID, pairingCode: code3 });
  check("P3 after five failed attempts a correct fresh pairing code is refused (lockout intact)", wrong.every((ok) => !ok) && !locked.ok, { wrong, correctCodeAfterwards: locked.ok ? "accepted" : locked.reason });
  const underLockout = await auth({ robotId: ROBOT_ID, token: T2 });
  check("P3 a valid session still reconnects while pairing is locked (lockout gates pairing only, as before)", underLockout.ok && underLockout.token === T2, { ok: underLockout.ok, reason: underLockout.reason });

  // R2 — a session in continuous use outlives the 24 h after its last AUTH. Clock-shifted rather
  // than waited for: with T2's socket open, the durable row is put 20 s from lapsing — where it
  // stands 23 h 59 min 40 s after the last AUTH — and the robot heartbeats at the Pi's 2 s cadence
  // until well past that instant (at least two of the backend's 15 s heartbeat flushes).
  const live = await auth({ robotId: ROBOT_ID, token: T2 }, { keepOpen: true });
  check("P3 R2: T2 holds an open session", live.ok, live.reason);
  const lapseAt = new Date(Date.now() + 20_000);
  await prisma.robotSession.update({ where: { robotDbId: robotRow.id }, data: { expiresAt: lapseAt } });
  if (live.ok) {
    const beats = setInterval(() => live.socket.emit("HEARTBEAT", {}), 2000);
    live.socket.emit("HEARTBEAT", {});
    await sleep(35_000);
    clearInterval(beats);
  }
  const renewed = await sessionRow(prisma, robotRow.id);
  const renewedAt = renewed.row ? new Date(renewed.row.expiresAt).getTime() : 0;
  check("P3 R2: while connected, the heartbeat slid the durable expiry a full lifetime ahead, past the instant it would have lapsed", Date.now() > lapseAt.getTime() && renewedAt > Date.now() + 86_400_000 - 60_000 && renewed.row.tokenHash === sha256(T2), {
    originalExpiry: lapseAt.toISOString(),
    now: new Date().toISOString(),
    expiresAt: renewed.row && renewed.row.expiresAt,
  });
  if (live.socket) live.socket.close();
  const log3 = server.logFile;
  const killed3 = await killServer(server);
  check("process 3 is dead and the port refuses connections", killed3.refused, killed3);

  /* ── process 4 ─────────────────────────────────────────────────────────── */
  server = await startServer();

  const afterLapse = await auth({ robotId: ROBOT_ID, token: T2 });
  check("P4 R2: after a restart, T2 — whose original expiry passed while it was connected — reconnects through the durable session", afterLapse.ok && afterLapse.token === T2, { ok: afterLapse.ok, reason: afterLapse.reason });
  // The KV is this new process's memory and holds no session, so a token-only AUTH can only have
  // been admitted by the durable record — whose `validate` slides the row's expiry once more.
  const afterLapseRow = await sessionRow(prisma, robotRow.id);
  const afterLapseAt = afterLapseRow.row ? new Date(afterLapseRow.row.expiresAt).getTime() : 0;
  check("P4 R2: that reconnect was admitted by the durable record (validate slid the row again)", afterLapseAt > renewedAt, {
    afterHeartbeats: renewed.row && renewed.row.expiresAt,
    afterReconnect: afterLapseRow.row && afterLapseRow.row.expiresAt,
  });

  await prisma.robotSession.update({ where: { robotDbId: robotRow.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await auth({ robotId: ROBOT_ID, token: T2 });
  check("P4 T2 is refused once its durable expiry has passed", !expired.ok, expired.reason);
  const log4 = server.logFile;
  await killServer(server);

  for (const [n, f] of [[1, log1], [2, log2], [3, log3], [4, log4]]) log(`server ${n} AUTH log:\n  ` + authLogLines(f).join("\n  "));
  await prisma.$disconnect();
  return finish();
}

function finish() {
  const failed = checks.filter((c) => !c.ok);
  log(`${checks.length - failed.length}/${checks.length} checks hold`);
  log(failed.length === 0 ? "C1 PASS" : "C1 FAIL");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[c1] harness error:", e);
  process.exit(2);
});
