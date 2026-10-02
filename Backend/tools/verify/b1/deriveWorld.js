"use strict";

/**
 * B1 measurement tooling — derive a scale-test world from a captured one. **Test-only**, and
 * only ever against the disposable loopback cluster. Nothing in `src/` requires it.
 *
 *   --legs N         leave only the first N queued Legs claimable (queue order: priority,
 *                    enqueuedAt). The rest get `availableAt` a day after the capture, so the
 *                    round's own queue filter skips them. Nothing else about them changes.
 *   --agents N       N < captured: un-place every agent after the first N (by business id) —
 *                    their `AgentCellPosition` rows are deleted, so they are neither indexed nor
 *                    in the shard's fleet. N > captured: clone the captured agents' rows (Robot,
 *                    Agent, BatteryState, AgentCellPosition, position Observations, current
 *                    ShardMembership) under new ids until N are placed. Clones are labelled
 *                    `-C<k>` in their business ids. A measurement fixture, not a fleet.
 *
 * Usage: node tools/verify/b1/deriveWorld.js --template <db> --name <db> --capture <json>
 *          [--legs N] [--agents N] [--server postgresql://pgverify@127.0.0.1:55720]
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const SERVER = new URL(arg("--server", "postgresql://pgverify@127.0.0.1:55720"));
if (!["127.0.0.1", "localhost"].includes(SERVER.hostname) || SERVER.port === "5432" || SERVER.port === "") {
  throw new Error("deriveWorld: loopback disposable cluster only");
}
const TEMPLATE = arg("--template");
const NAME = arg("--name");
const CAPTURE = JSON.parse(fs.readFileSync(arg("--capture"), "utf8"));
const LEGS = arg("--legs") === undefined ? null : Number(arg("--legs"));
const AGENTS = arg("--agents") === undefined ? null : Number(arg("--agents"));
const PG_BIN = process.env.PG_BIN || "C:/Program Files/PostgreSQL/18/bin";

const pg = (tool, ...rest) => {
  const out = spawnSync(path.join(PG_BIN, tool), ["-h", SERVER.hostname, "-p", SERVER.port, "-U", SERVER.username, ...rest], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${tool}: ${out.stderr}`);
  return out.stdout;
};
const sql = (text) => pg("psql.exe", "-v", "ON_ERROR_STOP=1", "-q", "-At", "-d", NAME, "-c", text);

pg("dropdb.exe", "--if-exists", NAME);
pg("createdb.exe", "-T", TEMPLATE, NAME);

const deferredUntil = new Date(CAPTURE.capturedAtMs + 24 * 3600 * 1000).toISOString();
if (LEGS !== null) {
  sql(`UPDATE "WorkQueue" SET "availableAt" = '${deferredUntil}'
       WHERE state = 'QUEUED' AND id NOT IN (
         SELECT id FROM "WorkQueue" WHERE state = 'QUEUED' ORDER BY priority ASC, "enqueuedAt" ASC LIMIT ${LEGS})`);
}

const placed = sql(`SELECT a.id FROM "AgentCellPosition" p JOIN "Agent" a ON a.id = p."agentId" ORDER BY a."agentId" ASC`)
  .trim()
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (AGENTS !== null && AGENTS < placed.length) {
  const keep = placed.slice(0, AGENTS).map((id) => `'${id}'`).join(",");
  sql(`DELETE FROM "AgentCellPosition" WHERE "agentId" NOT IN (${keep})`);
}

if (AGENTS !== null && AGENTS > placed.length) {
  let count = placed.length;
  for (let k = 1; count < AGENTS; k += 1) {
    for (const source of placed) {
      if (count >= AGENTS) break;
      const sfx = `-c${k}`;
      const SFX = `-C${k}`;
      sql(`
        WITH a AS (SELECT * FROM "Agent" WHERE id = '${source}')
        INSERT INTO "Robot" SELECT (jsonb_populate_record(NULL::"Robot", to_jsonb(r) || jsonb_build_object(
          'id', r.id || '${sfx}', 'robotId', r."robotId" || '${SFX}', 'currentTaskId', NULL))).*
        FROM "Robot" r JOIN a ON a."robotDbId" = r.id;
        INSERT INTO "Agent" SELECT (jsonb_populate_record(NULL::"Agent", to_jsonb(a) || jsonb_build_object(
          'id', a.id || '${sfx}', 'agentId', a."agentId" || '${SFX}', 'robotDbId', a."robotDbId" || '${sfx}'))).*
        FROM "Agent" a WHERE a.id = '${source}';
        INSERT INTO "BatteryState" SELECT (jsonb_populate_record(NULL::"BatteryState", to_jsonb(b) || jsonb_build_object(
          'id', b.id || '${sfx}', 'agentId', b."agentId" || '${sfx}'))).*
        FROM "BatteryState" b WHERE b."agentId" = '${source}';
        INSERT INTO "AgentCellPosition" SELECT (jsonb_populate_record(NULL::"AgentCellPosition", to_jsonb(p) || jsonb_build_object(
          'id', p.id || '${sfx}', 'agentId', p."agentId" || '${sfx}'))).*
        FROM "AgentCellPosition" p WHERE p."agentId" = '${source}';
        INSERT INTO "Observation" SELECT (jsonb_populate_record(NULL::"Observation", to_jsonb(o) || jsonb_build_object(
          'id', o.id || '${sfx}', 'agentId', o."agentId" || '${sfx}'))).*
        FROM "Observation" o WHERE o."agentId" = '${source}';
        INSERT INTO "ShardMembership" SELECT (jsonb_populate_record(NULL::"ShardMembership", to_jsonb(m) || jsonb_build_object(
          'id', m.id || '${sfx}', 'agentId', m."agentId" || '${sfx}'))).*
        FROM "ShardMembership" m WHERE m."agentId" = '${source}' AND m."supersededAt" IS NULL;
      `);
      count += 1;
    }
  }
}

const finalPlaced = sql(`SELECT count(*) FROM "AgentCellPosition"`).trim();
const claimable = sql(`SELECT count(*) FROM "WorkQueue" WHERE state = 'QUEUED' AND ("availableAt" IS NULL OR "availableAt" <= '${new Date(CAPTURE.capturedAtMs + 1000).toISOString()}')`).trim();
console.log(`[derive] ${NAME}: ${finalPlaced} agents placed, ${claimable} claimable Leg(s)`);
