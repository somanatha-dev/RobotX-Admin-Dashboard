#!/usr/bin/env node
"use strict";

/**
 * Operator holds — who is held, why, and what is SIMULATED vs PHYSICAL. READ-ONLY.
 *
 *   node tools/ops/operatorHolds.js [--json]
 *
 * Reads `DATABASE_URL` (load the LOCAL environment first) and refuses any database that is not on
 * this machine (127.0.0.1 / localhost): it never reads a hosted or production database. It issues
 * no write of any kind — no status change, no command, no event.
 *
 * For every robot it prints:
 *   · kind — SIMULATED or PHYSICAL (`Robot.simulated`, the commissioning record) — check this
 *     BEFORE any recovery action;
 *   · its persisted status (and `statusBeforeOffline` when OFFLINE);
 *   · the hold's PROVENANCE: the STOP/PAUSE command that placed it (`Command`, written by
 *     `POST /api/robots/:id/command`, which places the server-side hold), or UNEXPLAINED when no
 *     STOP/PAUSE is on record — a hold nobody commanded is something to investigate, not to clear;
 *   · for a held robot, the release procedure. A hold is never lifted by this tool and never by a
 *     direct database write: it is the operator's gated act (P7-D1) —
 *       1. RESUME the robot:   POST /api/robots/<id>/command   { "type": "RESUME" }
 *       2. wait until the robot itself reports IDLE or ACTIVE (its live state),
 *       3. lift the hold:      POST /api/robots/<id>/clear-fault
 *                              { "reason": "<why>", "secondApproverId": "<another user's id>" }
 *          as a SUPER_ADMIN (QUARANTINE_OVERRIDE: elevated role, recorded reason, a distinct
 *          second approver; both audited). The server re-checks the live state and refuses
 *          (409) if the robot is not connected or not running.
 *     ERROR is a fault, released by the same route only out of an actual fault state.
 */

const path = require("path");

const HELD = Object.freeze(["PAUSED"]);
const FAULTED = Object.freeze(["ERROR"]);

/**
 * Pure: the hold, its provenance and the next step, for one robot and its recent commands.
 *
 * @param {{ robotId: string, simulated: boolean, status: string, statusBeforeOffline?: string|null }} robot
 * @param {{ type: string, status: string, issuedAt: Date|string }[]} commands newest first
 * @returns {object}
 */
function describeHold(robot, commands) {
  const effective = robot.status === "OFFLINE" && robot.statusBeforeOffline ? robot.statusBeforeOffline : robot.status;
  const kind = robot.simulated === true ? "SIMULATED" : "PHYSICAL";
  const base = { robotId: robot.robotId, kind, status: robot.status, statusBeforeOffline: robot.statusBeforeOffline ?? null };
  if (FAULTED.includes(effective)) {
    return { ...base, hold: "FAULT", provenance: "a fault (ERROR) — not an operator hold", next: "investigate the fault; clear it with POST /clear-fault (QUARANTINE_OVERRIDE) only once resolved" };
  }
  if (!HELD.includes(effective)) return { ...base, hold: null, provenance: null, next: null };
  const placing = (commands || []).find((c) => c && (c.type === "STOP" || c.type === "PAUSE"));
  if (!placing) {
    return {
      ...base,
      hold: "OPERATOR_HOLD",
      provenance: "UNEXPLAINED — no STOP/PAUSE command on record for this robot",
      next: "investigate before releasing: a hold nobody commanded may be a unit's own stop report or an older hold",
    };
  }
  return {
    ...base,
    hold: "OPERATOR_HOLD",
    provenance: `${placing.type} command at ${new Date(placing.issuedAt).toISOString()} (${placing.status})`,
    next:
      `RESUME → wait for the robot to report IDLE/ACTIVE → POST /api/robots/${robot.robotId}/clear-fault ` +
      '{ reason, secondApproverId } as SUPER_ADMIN',
  };
}

/** Refuse anything that is not a database on this machine. */
function assertLocalDatabase(url) {
  let host = null;
  try {
    host = new URL(url).hostname;
  } catch {
    host = null;
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`refused: DATABASE_URL does not name a database on this machine (host ${host || "unreadable"}); this tool reads LOCAL only`);
  }
}

async function main() {
  const asJson = process.argv.includes("--json");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — load the LOCAL environment first");
  assertLocalDatabase(process.env.DATABASE_URL);
  const { PrismaClient } = require(path.resolve(__dirname, "../../node_modules/@prisma/client"));
  const prisma = new PrismaClient();
  try {
    const robots = await prisma.robot.findMany({
      select: { robotId: true, simulated: true, status: true, statusBeforeOffline: true, commands: { orderBy: { issuedAt: "desc" }, take: 10, select: { type: true, status: true, issuedAt: true } } },
      orderBy: { robotId: "asc" },
    });
    const rows = robots.map((r) => describeHold(r, r.commands));
    if (asJson) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    for (const row of rows) {
      process.stdout.write(`${row.robotId}  ${row.kind}  ${row.status}${row.statusBeforeOffline ? ` (was ${row.statusBeforeOffline})` : ""}\n`);
      if (row.hold) process.stdout.write(`    hold: ${row.hold} — ${row.provenance}\n    next: ${row.next}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { describeHold, assertLocalDatabase };
