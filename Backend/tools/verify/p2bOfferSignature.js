#!/usr/bin/env node
"use strict";

/**
 * P2B-2 — OFFER signature canonicalisation, end to end.
 *
 *   node tools/verify/p2bOfferSignature.js --fixture <out.json>
 *       Build an OFFER through the real production path (`executionGeometry.attachStopPaths`
 *       → `offers.enqueueOffer` → outbox row → JSON storage → `outbox.worker.envelopeOf` →
 *       the addressee rewrite → JSON on the wire), sign it with the published TEST-VECTOR
 *       key below, verify it with the independent wire-only canonicaliser
 *       (`wireCanonical.js`), and write the vector for the Pi's own test suite.
 *
 *   node tools/verify/p2bOfferSignature.js --live <DATABASE_URL>
 *       Verify every signed command the backend actually wrote to a database's Outbox
 *       (OFFER, WITHDRAW, RECALL, …) against COMMAND_SIGNING_KEY from the environment,
 *       reconstructing each envelope exactly as the delivery arm puts it on the wire.
 *       The key is read from the environment and never printed.
 *
 * The test-vector key is **not a secret** and is refused as a production key by nothing
 * here only because nothing here runs in production: it exists so a second implementation
 * (the Pi's, in Python) can check itself against bytes the backend produced. It must never
 * be configured as COMMAND_SIGNING_KEY anywhere real.
 */

const fs = require("fs");
const path = require("path");

const offers = require("../../src/engine/dispatch/offers");
const executionGeometry = require("../../src/services/executionGeometry.service");
const { envelopeOf } = require("../../src/workers/outbox.worker");
const wire = require("./wireCanonical");

/** Published test vector key — public by design, never a deployment key. @structural */
const TEST_VECTOR_KEY = "robotx-p2b2-offer-signature-TEST-VECTOR-not-a-secret";

/** A fake transaction: enough of the Outbox for `enqueueOffer` to allocate and insert. */
function captureTx() {
  const rows = [];
  return {
    rows,
    outbox: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async ({ data }) => {
        const row = { id: "ob-p2b2-fixture-0001", state: "PENDING", ...data };
        rows.push(row);
        return row;
      },
    },
  };
}

/** What Prisma's Json column and the socket transport both do to a payload. */
const throughJson = (value) => JSON.parse(JSON.stringify(value));

/**
 * Build one OFFER exactly as production does and return what reaches the agent.
 *
 * @param {{ key: string, storeTime: Date }} input
 */
async function buildWireOffer({ key, storeTime }) {
  // Real execution geometry, from a directions provider shaped like Mapbox's answer.
  // Edge values on purpose: a non-ASCII site name (JS emits it raw; Python's json escapes
  // it unless ensure_ascii=False), a tiny exponent below (JS `5e-7`, Python `5e-07`), and
  // integral numbers (JS never writes `120.0`).
  const geometry = await executionGeometry.attachStopPaths({
    from: { lat: 12.906, lon: 77.499 },
    stops: [
      { sequence: 1, stopType: "PICKUP", siteId: "SITE-GATE-1", lat: 12.9081, lon: 77.5012, projectedArrivalMs: 1790000060000, departureMs: 1790000070000 },
      { sequence: 2, stopType: "DROP", siteId: "SITE-ಬ್ಲಾಕ್-C", lat: 12.9105, lon: 77.5044, projectedArrivalMs: 1790000200000, departureMs: null },
    ],
    directions: async ({ from, to }) => ({
      points: [
        { lat: from.lat, lon: from.lon },
        { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 + 0.0000005 },
        { lat: to.lat, lon: to.lon },
      ],
      distanceMeters: 120,
    }),
  });

  const tx = captureTx();
  const commitment = { commitmentId: "CMT-P2B2-FIXTURE", fence: 42n, legId: "leg-row-fixture", agentId: "agent-row-fixture" };
  await offers.enqueueOffer(tx, {
    commitment,
    addressee: "robotx-pi",
    storeTime,
    offerTtlSeconds: 20,
    signingKey: key,
    offer: {
      missionPlan: "PLAN-P2B2-FIXTURE",
      stopSequence: geometry.stops,
      taskId: "TSK-P2B2-FIXTURE",
      routeReference: null,
      payloadManifest: ["MAN-1"],
      energyReserveParams: { reserveFloorWh: 50, returnLegWh: 12.5, marginFraction: 0.1, residualCv: 5e-7 },
      targetSoc: 0.8,
    },
  });
  const row = tx.rows[0];

  // Stored (Json column), claimed, enveloped, addressed to the wire identity
  // (`leaderWorkers.js` rewrites `agentId` to the robot code), and sent as JSON.
  const stored = { ...row, payload: throughJson(row.payload) };
  const envelope = { ...envelopeOf(stored), agentId: "robotx-pi" };
  const wireText = JSON.stringify(envelope);
  return { wireText, wireEnvelope: JSON.parse(wireText) };
}

async function fixture(outPath) {
  const storeTime = new Date("2026-09-24T10:00:00.000Z");
  const { wireText, wireEnvelope } = await buildWireOffer({ key: TEST_VECTOR_KEY, storeTime });
  const verdict = wire.verifyFromWire(wireEnvelope, TEST_VECTOR_KEY);
  if (!verdict.ok) {
    console.error("FAIL — the independent wire canonicaliser does not reproduce the backend signature");
    console.error({ expected: verdict.expected, given: verdict.given });
    process.exit(1);
  }
  const vector = {
    description:
      "RobotX OFFER signature test vector (P2B-2). Generated by the backend's real OFFER path. " +
      "The key is a PUBLIC TEST VECTOR — never configure it as a deployment key.",
    key: TEST_VECTOR_KEY,
    keyEncoding: "utf-8",
    algorithm: "HMAC-SHA256, lower-case hex",
    separator: "\\u001f (ASCII unit separator)",
    signedFields: wire.SIGNED_FIELDS,
    wire: wireText,
    canonical: verdict.canonical,
    signature: verdict.expected,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(vector, null, 2)}\n`);
  console.log(`PASS — fixture written to ${outPath}`);
  console.log(`       signature ${verdict.expected}`);
}

async function live(databaseUrl) {
  const key = process.env.COMMAND_SIGNING_KEY;
  if (!key) {
    console.error("COMMAND_SIGNING_KEY is not set; the run's key is needed to verify its rows");
    process.exit(2);
  }
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const rows = await prisma.outbox.findMany({ orderBy: { createdAt: "asc" } });
    const agents = new Map((await prisma.agent.findMany({ select: { id: true, agentId: true } })).map((a) => [a.id, a.agentId]));
    const byCommand = {};
    let failures = 0;
    let firstFailure = null;
    for (const row of rows) {
      const envelope = { ...envelopeOf(row), agentId: agents.get(row.agentId) || row.agentId };
      const wireEnvelope = JSON.parse(JSON.stringify(envelope));
      const verdict = wire.verifyFromWire(wireEnvelope, key);
      byCommand[row.command] = byCommand[row.command] || { rows: 0, verified: 0 };
      byCommand[row.command].rows += 1;
      if (verdict.ok) byCommand[row.command].verified += 1;
      else {
        failures += 1;
        if (!firstFailure) firstFailure = { id: row.id, command: row.command, canonical: verdict.canonical.slice(0, 600) };
      }
    }
    console.log(JSON.stringify({ rows: rows.length, byCommand, failures }, null, 2));
    if (firstFailure) console.log("first failure:", JSON.stringify(firstFailure, null, 2));
    process.exit(failures === 0 && rows.length > 0 ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  const [mode, arg] = process.argv.slice(2);
  const run = mode === "--fixture" ? fixture(arg) : mode === "--live" ? live(arg) : Promise.reject(new Error("usage: --fixture <out.json> | --live <DATABASE_URL>"));
  run.catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { TEST_VECTOR_KEY, buildWireOffer };
