"use strict";

/**
 * Engine lane — the Phase 14 **remediation** regressions.
 *
 * Every test here is a defect that was live in the tree after Phase 14's implementation
 * report and its independent verification, and that neither found. Each is written as the
 * *reproduction first*: the assertion states the behaviour that was wrong, so a future
 * change that reintroduces it fails here by name rather than by a distant symptom.
 *
 * The findings this file pins, by id:
 *
 *   · **P14-R1** — the pinned configuration snapshot never reached the agent socket
 *     handlers, because they read `socket.request.app.locals.config` and the Socket.IO
 *     upgrade request never passes through the express app. Five registered parameters,
 *     three of them Safety-class, therefore had no production consumer.
 *   · **P14-R2** — `persistentImplausibility()` treats an unresolved threshold as
 *     `Infinity`, so §23.5's "persistent implausibility triggers quarantine and a security
 *     event" could never fire. The value is retained (there is no honest definition of
 *     "persistent" without a threshold); the silence is not.
 *   · **P14-R3** — an **empty** `security.elevated_roles` meant "every role is elevated"
 *     rather than "no role is", in both authorisation functions.
 *   · **P14-R4** — the manual-assignment action-class gate only fired when the body also
 *     named an agent, so a waiver could be requested past it.
 *   · **P14-R5** — `authoriseWaiver()` decisions were never audited, so
 *     `OverrideAudit.predicateId` had no writer and §23.6's per-predicate override rate
 *     read an empty column by construction.
 *   · **P14-R6** — `override.rates()` / `breaches()` had no caller anywhere.
 *   · **P14-R7** — §23.7's positive half had no production producer: no identity record,
 *     no `Stop.identityKey`, no `surrogateKeys` on any decision record or snapshot.
 *   · **P14-R8** — the `session:{agentId}` namespace held either a certificate binding or
 *     a bearer token, and the legacy branch compared the first as though it were the
 *     second.
 *   · **P14-R9** — `sessionBinding.assertBound()` had no production caller.
 */

const fs = require("fs");
const path = require("path");

const override = require("../../src/engine/security/override");
const trustBoundaries = require("../../src/engine/security/trustBoundaries");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const tierA = require("../../src/engine/observability/tierA");
const tierB = require("../../src/engine/observability/tierB");
const certificateRotation = require("../../src/workers/certificateRotation.worker");
const privacyKeys = require("../../src/config/privacyKeys");
const surrogateKeysModule = require("../../src/engine/privacy/surrogateKeys");
const { codeOnly } = require("../../src/engine/guards/sourceScan");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const sourceOf = (...segments) => codeOnly(fs.readFileSync(path.join(BACKEND_ROOT, ...segments), "utf8"));

// ───────────────────────────────────────────────────────────────────────────
// P14-R1 — the configuration snapshot reaches the agent socket handlers
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R1 — the pinned configuration reaches the agent handlers", () => {
  // The defect was a *path that does not exist*, which no unit test can observe by
  // calling a function: `socket.request` is the raw HTTP upgrade request and has no `app`
  // property, so the expression evaluated to `undefined` in every deployment while
  // reading, in review, exactly like a correct one. A source assertion is the level the
  // defect lives at.
  test("neither agent handler resolves configuration through `socket.request.app` alone", () => {
    for (const handler of ["robot.handler.js", "telemetry.handler.js"]) {
      const source = sourceOf("src", "sockets", "handlers", handler);
      // The express app's locals must be threaded in; `socket.request.app` may remain
      // only as a secondary fallback, never as the sole route.
      expect({ handler, threaded: source.includes("appLocals") }).toEqual({ handler, threaded: true });
      expect({ handler, engineConfig: source.includes("io?.engine?.config") }).toEqual({ handler, engineConfig: false });
    }
  });

  test("the socket server accepts `appLocals` and passes it to both agent handlers", () => {
    const source = sourceOf("src", "sockets", "socket.server.js");
    expect(source).toMatch(/function initSocketServer\(io, \{[^)]*appLocals/);
    expect(source).toMatch(/registerRobotHandlers\(io, socket, \{[^}]*appLocals[^}]*\}\)/);
    expect(source).toMatch(/registerTelemetryHandlers\(io, socket, \{[^}]*appLocals[^}]*\}\)/);
  });

  test("`server.js` supplies `app.locals` by reference, so a republished snapshot is seen", () => {
    const source = sourceOf("server.js");
    expect(source).toMatch(/initSocketServer\(io, \{[^}]*appLocals: app\.locals[^}]*\}\)/);
  });

  test("the express app carries a resolvable snapshot from module load, so the thread has something to carry", () => {
    // eslint-disable-next-line global-require
    const app = require("../../src/app");
    const values = app.locals.config && app.locals.config.values;
    const read = (name) => (values instanceof Map ? values.get(name) : values && values[name]);

    // The five parameters P14-R1 starved, all Phase 14's own.
    for (const name of [
      "security.implausible_report_quarantine_threshold",
      "security.session_max_age",
      "security.certificate_revocation_recheck_interval",
      "security.position_plausibility_tolerance",
      "security.energy_rate_tolerance",
    ]) {
      expect({ name, resolved: Number.isFinite(read(name)) }).toEqual({ name, resolved: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R2 — an unconfigured quarantine threshold is loud, not silent
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R2 — §23.5's quarantine control reports when it is switched off", () => {
  test("with no threshold, no quarantine is raised — and the result says the threshold was never configured", () => {
    const verdict = trustBoundaries.persistentImplausibility({ agentId: "AGT-1", rejections: 9_999 });
    // The value is unchanged and deliberately so: with no threshold there is no
    // definition of "persistent", and quarantining on the first refused report would be a
    // different and worse rule.
    expect(verdict.quarantine).toBe(false);
    // What changed is that the caller can now tell "nobody misbehaved" from "the check
    // cannot fire".
    expect(verdict.thresholdConfigured).toBe(false);
  });

  test("with a threshold, the control fires and reports itself as configured", () => {
    const below = trustBoundaries.persistentImplausibility({ agentId: "AGT-1", rejections: 2, threshold: 3 });
    expect(below).toMatchObject({ quarantine: false, securityEvent: false, thresholdConfigured: true });

    const at = trustBoundaries.persistentImplausibility({ agentId: "AGT-1", rejections: 3, threshold: 3 });
    expect(at).toMatchObject({ quarantine: true, securityEvent: true, thresholdConfigured: true });
    expect(at.reason).toMatch(/security\.implausible_report_quarantine_threshold/);
  });

  test("the capability-claim path counts against the same threshold, rather than none at all", () => {
    const source = sourceOf("src", "sockets", "handlers", "telemetry.handler.js");
    // It previously read `recordImplausibleReport(robotId)` with no second argument, so a
    // compromised agent could send capability claims without limit and never escalate.
    expect(source).not.toMatch(/recordImplausibleReport\(robotId\)\s*;/);
    expect(source).toMatch(/recordImplausibleReport\(robotId, quarantineThreshold\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R3 — an empty elevated-role list admits nobody
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R3 — `security.elevated_roles: []` means no role, not every role", () => {
  const waiver = (role) => ({
    predicateId: "F9",
    constraintClass: "P",
    actorId: "ops-1",
    actorRole: role,
    reason: "the loading bay is closed and the alternate is two minutes away",
  });

  test("REPRODUCTION — an empty list refuses every role, including the one that used to be elevated", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "VIEWER", undefined, null]) {
      const decision = override.authoriseWaiver(waiver(role), { elevatedRoles: [] }, {});
      expect({ role, granted: decision.granted, refusal: decision.refusal }).toEqual({
        role,
        granted: false,
        refusal: override.REFUSAL.ROLE_NOT_ELEVATED,
      });
    }
  });

  test("an absent list is still unscoped — the documented meaning, unchanged", () => {
    expect(override.authoriseWaiver(waiver("ANY_ROLE"), {}, {}).granted).toBe(true);
    expect(override.roleAdmitted(undefined, "ANY_ROLE")).toBe(true);
    expect(override.roleAdmitted(null, "ANY_ROLE")).toBe(true);
  });

  test("a populated list admits its members and refuses everyone else", () => {
    expect(override.authoriseWaiver(waiver("SUPER_ADMIN"), { elevatedRoles: ["SUPER_ADMIN"] }, {}).granted).toBe(true);
    expect(override.authoriseWaiver(waiver("VIEWER"), { elevatedRoles: ["SUPER_ADMIN"] }, {}).refusal).toBe(
      override.REFUSAL.ROLE_NOT_ELEVATED,
    );
  });

  test("the same rule holds for the action-class path — all four classes", () => {
    for (const definition of override.ACTION_CLASSES) {
      const decision = override.authoriseAction(
        {
          actionClass: definition.id,
          actorId: "ops-1",
          actorRole: "SUPER_ADMIN",
          reason: "r",
          secondApproverId: "ops-2",
        },
        { elevatedRoles: [] },
        {},
      );
      expect({ id: definition.id, granted: decision.granted, refusal: decision.refusal }).toEqual({
        id: definition.id,
        granted: false,
        refusal: override.REFUSAL.ROLE_NOT_ELEVATED,
      });
    }
  });

  test("the empty-list refusal says so, rather than naming an empty set of roles", () => {
    const decision = override.authoriseAction(
      { actionClass: "QUARANTINE_OVERRIDE", actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "r", secondApproverId: "ops-2" },
      { elevatedRoles: [] },
      {},
    );
    expect(decision.detail).toMatch(/the elevated-role list is empty: no role is authorised/);
  });

  test("class I, R and F remain refused before the role is consulted at all", () => {
    // The ordering property the phase's central safety claim rests on: the class check
    // must precede the role check, so widening or narrowing the role list can never make
    // an absolute class negotiable in either direction.
    for (const constraintClass of override.NEVER_WAIVABLE) {
      for (const policy of [{ elevatedRoles: [] }, { elevatedRoles: ["SUPER_ADMIN"] }, {}, null]) {
        const decision = override.authoriseWaiver(
          { predicateId: "F3", constraintClass, actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "r", secondApproverId: "ops-2" },
          policy,
          {},
        );
        expect({ constraintClass, refusal: decision.refusal }).toEqual({
          constraintClass,
          refusal: override.REFUSAL.CLASS_NOT_WAIVABLE,
        });
      }
    }
  });

  test("neither controller evaluates a waiver against a hard-coded empty policy any more", () => {
    for (const controller of ["tasks.controller.js", "robots.controller.js"]) {
      const source = sourceOf("src", "controllers", controller);
      expect({ controller, hardCoded: /\{\s*elevatedRoles:\s*\[\]\s*\}/.test(source) }).toEqual({ controller, hardCoded: false });
      expect({ controller, usesPolicy: source.includes("policyFor(req)") }).toEqual({ controller, usesPolicy: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R4 — the manual-assignment gate fires on the waiver alone
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R4 — a waiver request cannot skip the action-class gate", () => {
  test("REPRODUCTION — the gate no longer requires the body to also name an agent", () => {
    const source = sourceOf("src", "routes", "tasks.routes.js");
    // The old form: `if (!waives || !names) return next();` — a request carrying
    // `waivePredicate` and no `robotId` walked past the gate entirely.
    expect(source).not.toMatch(/if\s*\(!waives\s*\|\|\s*!names\)/);
    expect(source).toMatch(/if\s*\(!req\.body\?\.waivePredicate\)\s*return next\(\)/);
  });

  test("an ordinary assignment — no waiver — is still ungated, which is the whole compatibility argument", () => {
    const source = sourceOf("src", "routes", "tasks.routes.js");
    expect(source).toMatch(/return next\(\)/);
    expect(source).toMatch(/return manualAssignmentGate\(req, res, next\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R5 / P14-R6 — waiver decisions are audited, and the rates are monitored
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R5 — §23.6's 'every override is audited' covers the waiver path", () => {
  test("both waiver call sites write the audit row", () => {
    for (const controller of ["tasks.controller.js", "robots.controller.js"]) {
      const source = sourceOf("src", "controllers", controller);
      expect({ controller, audited: source.includes("recordAuthorisation(") }).toEqual({ controller, audited: true });
    }
  });

  test("the row carries the predicate and its class, which is what the per-predicate rate groups by", () => {
    const row = override.toOverrideAuditRow(
      { granted: false, refusal: override.REFUSAL.CLASS_NOT_WAIVABLE },
      { predicateId: "F3", constraintClass: "I", actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "r" },
      { subjectType: "ROBOT", subjectId: "AGT-1" },
    );
    expect(row).toMatchObject({ predicateId: "F3", constraintClass: "I", granted: false });
    // The refusal reason is mandatory on a refused row and forbidden on a granted one —
    // the `OverrideAudit_refusal_reason_consistent` CHECK, satisfied by construction.
    expect(row.refusalReason).toBe(override.REFUSAL.CLASS_NOT_WAIVABLE);
  });
});

describe("P14-R6 — the override-rate design signal has a production caller", () => {
  const auditRows = (rows) => ({ prisma: { overrideAudit: { findMany: async () => rows } } });

  test("REPRODUCTION — the worker evaluates §23.6's rates on its tick", async () => {
    const rows = [
      { actorId: "ops-1", predicateId: "F9", actionClass: null, granted: true },
      { actorId: "ops-1", predicateId: "F9", actionClass: null, granted: true },
      { actorId: "ops-2", predicateId: "F9", actionClass: null, granted: true },
      // A refusal is counted in the total and never in the rate: waiving nothing is not
      // an override.
      { actorId: "ops-3", predicateId: "F3", actionClass: null, granted: false },
    ];

    const result = await certificateRotation.sweepOverrideRates(auditRows(rows), {
      now: new Date("2026-08-19T00:00:00Z"),
      windowSeconds: 604_800,
      perPredicate: 3,
      perOperator: 2,
    });

    expect(result.measured.total).toBe(4);
    expect(result.measured.granted).toBe(3);
    // Per predicate first — "the predicate is usually the thing that is wrong".
    expect(result.measured.perPredicate[0]).toEqual({ predicateId: "F9", count: 3 });
    expect(result.breaches.findings.map((finding) => finding.kind).sort()).toEqual(["OPERATOR", "PREDICATE"]);
    expect(result.breaches.findings.find((f) => f.kind === "PREDICATE").interpretation).toMatch(/likely miscalibrated/);
  });

  test("an unset window evaluates nothing rather than counting all of history", async () => {
    const result = await certificateRotation.sweepOverrideRates(auditRows([{ actorId: "ops-1", predicateId: "F9", granted: true }]), {
      now: new Date(),
    });
    // A rate over an unbounded window crosses any threshold eventually, which would make
    // the design signal fire for every deployment that had ever taken an override.
    expect(result.windowFrom).toBeNull();
    expect(result.breaches.findings).toEqual([]);
  });

  test("the tick surfaces the findings, and `server.js` logs them without acting on the operator", () => {
    const worker = sourceOf("src", "workers", "certificateRotation.worker.js");
    expect(worker).toMatch(/overrideRateFindings/);
    const server = sourceOf("server.js");
    expect(server).toMatch(/onOverrideRateFinding/);
    // §23.6 — "neither punitive by default". The worker returns findings; it writes
    // nothing back and restricts no one.
    expect(worker).not.toMatch(/elevatedRoles\s*[:=]/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R7 — §23.7's surrogate keys reach the decision records
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R7 — the decision record and the snapshot carry surrogate keys", () => {
  const stopStore = (rows) => ({ prisma: { stop: { findMany: async ({ where }) => rows.filter((row) => where.legId.in.includes(row.legId)) } } });

  test("REPRODUCTION — the writer resolves the keys the round's Legs reference", async () => {
    const deps = stopStore([
      { legId: "leg-a", identityKey: "sk_stop_" + "a".repeat(32) },
      { legId: "leg-a", identityKey: "sk_stop_" + "b".repeat(32) },
      { legId: "leg-b", identityKey: "sk_stop_" + "c".repeat(32) },
      { legId: "leg-other", identityKey: "sk_stop_" + "d".repeat(32) },
    ]);

    const resolved = await decisionRecord.surrogateKeysFor(deps, ["leg-b", "leg-a", "leg-a"]);

    expect(resolved.byLeg.get("leg-a")).toEqual(["sk_stop_" + "a".repeat(32), "sk_stop_" + "b".repeat(32)]);
    expect(resolved.byLeg.get("leg-b")).toEqual(["sk_stop_" + "c".repeat(32)]);
    // A Leg the round did not decide contributes nothing.
    expect(resolved.all).toEqual(["sk_stop_" + "a".repeat(32), "sk_stop_" + "b".repeat(32), "sk_stop_" + "c".repeat(32)]);
  });

  test("the result is a total order, so two runs over one round produce identical bytes", async () => {
    const rows = [
      { legId: "leg-a", identityKey: "sk_stop_" + "c".repeat(32) },
      { legId: "leg-a", identityKey: "sk_stop_" + "a".repeat(32) },
      // A duplicate: two Stops at one address share one identity record, which is the
      // stability §23.7 requires and would otherwise show up as a repeated key.
      { legId: "leg-a", identityKey: "sk_stop_" + "a".repeat(32) },
    ];
    const first = await decisionRecord.surrogateKeysFor(stopStore(rows), ["leg-a"]);
    const second = await decisionRecord.surrogateKeysFor(stopStore([...rows].reverse()), ["leg-a"]);
    expect(first.byLeg.get("leg-a")).toEqual(second.byLeg.get("leg-a"));
    expect(first.byLeg.get("leg-a")).toEqual(["sk_stop_" + "a".repeat(32), "sk_stop_" + "c".repeat(32)]);
  });

  test("a Leg whose Stops predate the identity store contributes no null entries", async () => {
    const resolved = await decisionRecord.surrogateKeysFor(stopStore([]), ["leg-a"]);
    expect(resolved.byLeg.get("leg-a")).toEqual([]);
    expect(resolved.all).toEqual([]);
  });

  test("the snapshot row carries the round's keys", () => {
    const row = decisionRecord.snapshotRow({
      snapshot: { snapshotId: "snap-1", hash: "h", pins: {} },
      roundId: "r1",
      shardId: "s1",
      decisionTimeMs: 1_800_000_000_000,
      surrogateKeys: ["sk_stop_" + "a".repeat(32)],
    });
    expect(row.surrogateKeys).toEqual(["sk_stop_" + "a".repeat(32)]);
  });

  test("the column rides beside the record and never inside it, so §24.3's comparison is unchanged", () => {
    // This is the property that makes the column safe to add to an already-golden corpus:
    // the reconstruction gate compares `digest(record)` and `contentHash`, and neither
    // sees `surrogateKeys`.
    const tierASource = sourceOf("src", "engine", "observability", "tierA.js");
    const tierBSource = sourceOf("src", "engine", "observability", "tierB.js");
    // Present in `toRow` (the row shape) and absent from `build` (the hashed record).
    expect(tierASource).toMatch(/surrogateKeys: Array\.isArray\(more\.surrogateKeys\)/);
    expect(tierBSource).toMatch(/surrogateKeys: Array\.isArray\(more\.surrogateKeys\)/);
    expect(tierASource.split("function toRow")[0]).not.toMatch(/surrogateKeys/);
    expect(tierBSource.split("function toRow")[0]).not.toMatch(/surrogateKeys/);
  });

  test("an absent key list writes null rather than an empty array", () => {
    // Null is "this decision's subjects predate the identity store"; `[]` would be "this
    // decision pointed at nothing", and the two are different facts.
    expect(tierA.toRow(minimalTierARecord(), {}).surrogateKeys).toBeNull();
    expect(tierB.toRow(minimalTierBRecord(), {}).surrogateKeys).toBeNull();
  });

  test("the two secrets §23.7 requires are readable from one boundary and refuse a default", () => {
    expect(privacyKeys.configured()).toBe(true);
    expect(() => privacyKeys.fromEnvironment({ PRIVACY_IDENTITY_KEY: "00" })).toThrow(/PRIVACY_SURROGATE_SECRET is unset/);
    expect(() => privacyKeys.fromEnvironment({ PRIVACY_SURROGATE_SECRET: "x" })).toThrow(/PRIVACY_IDENTITY_KEY is unset/);
    // One reader, so the backfill and the request path cannot mint different keys for one
    // address.
    expect(sourceOf("tools", "migrate", "backfillIdentities.js")).toMatch(/privacyKeys\.fromEnvironment\(\)/);
    expect(sourceOf("tools", "migrate", "backfillIdentities.js")).not.toMatch(/process\.env\.PRIVACY_/);
  });

  test("the backfill no longer claims the engine populates the derived quantities", () => {
    const raw = fs.readFileSync(path.join(BACKEND_ROOT, "tools", "migrate", "backfillIdentities.js"), "utf8");
    // The claim was a handoff to a consumer that does not exist — no module in `src/`
    // writes `zoneId`, `geofenceResult`, `accessWindowClass`, `serviceTimeCohort` or
    // `routingNodeId` on a Stop.
    expect(raw).not.toMatch(/populated by the engine when it next plans against the Stop — which is\s*\n \* correct/);
    expect(raw).toMatch(/P14-R7/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R12 / P14-R13 — §23.7's storage rule is enforced, at runtime and at build
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R12 — the decision-record writer refuses a record holding an identifying value", () => {
  /** A store that records what it was asked to write and never rejects anything itself. */
  function capturingStore() {
    const writes = { snapshots: [], tierA: [], tierB: [] };
    return {
      writes,
      prisma: {
        stop: { findMany: async () => [] },
        inputSnapshot: { upsert: async ({ create }) => { writes.snapshots.push(create); return { id: "snap-row-1" }; } },
        decisionRecordA: { create: async ({ data }) => { writes.tierA.push(data); return data; } },
        decisionRecordB: { create: async ({ data }) => { writes.tierB.push(data); return data; } },
      },
    };
  }

  // The sections §21.2 passes through **wholesale** rather than field by field, which is
  // where a value the builder never named can reach the row: the Overrides section (which
  // carries whatever an operator action recorded), the Predictions section, the outcome's
  // free-form `detail`, and the snapshot's `pins`. `tierA.build()` whitelists the Leg's
  // own fields, so those are not a route; these are.
  const roundOf = (context) => ({
    round: {
      roundId: "r1",
      shardId: "s1",
      decisionTimeMs: 1_800_000_000_000,
      decisions: [{ legId: "leg-a", outcome: "ASSIGNED", agentId: "AGT-1" }],
      committed: [],
      partitions: [],
      columns: { generated: 0, pruned: 0, bestPrunedGammaMilliCU: null },
      budgets: { budgetLimited: false, exceeded: [] },
      regime: "NORMAL",
    },
    context: {
      shardId: "s1",
      snapshot: { snapshotId: "snap-1", hash: "h", pins: {} },
      trigger: "NEW_ARRIVAL",
      perLeg: {},
      legMeta: { purpose: "PRIMARY", tenantId: "t1" },
      ...context,
    },
    budget: { offer: () => ({ verdict: "NOT_SELECTED", writtenBecause: null, reason: null, draw: 0.9, sampleRate: 0 }) },
    config: { sampleRate: 0, compactTopN: 5, fullRetentionDays: 30, tierBRetentionDays: 7, snapshotRetentionDays: 30 },
    nowMs: 1_800_000_000_000,
  });

  test("a clean round writes normally", async () => {
    const store = capturingStore();
    const result = await decisionRecord.writeRound({ prisma: store.prisma }, roundOf({}));
    expect(result.tierACount).toBe(1);
    expect(store.writes.tierA).toHaveLength(1);
    expect(store.writes.snapshots).toHaveLength(1);
  });

  test("REPRODUCTION — an address reaching the Overrides section is refused, and the Tier A row is not written", async () => {
    const store = capturingStore();
    // §21.2's Overrides row is "Any operator action, with identity, reason, and predicate
    // waived", and it is written through unfiltered. An operator whose recorded reason
    // named the destination would have put a street address into a decision record —
    // through a route neither build gate covers, because the value arrives at runtime and
    // no scanned module names the field.
    await expect(
      decisionRecord.writeRound(
        { prisma: store.prisma },
        roundOf({ overrides: [{ actorId: "ops-1", predicateId: "F9", label: "12 Acacia Avenue" }] }),
      ),
    ).rejects.toThrow(/holds identifying value\(s\) at .*label/);

    expect(store.writes.tierA).toHaveLength(0);
  });

  test("a raw coordinate in the Predictions section is refused — six decimal places of latitude is a doorstep", async () => {
    const store = capturingStore();
    await expect(
      decisionRecord.writeRound({ prisma: store.prisma }, roundOf({ predictions: { lat: 51.523456, lon: -0.158765 } })),
    ).rejects.toThrow(/holds identifying value\(s\)/);
    expect(store.writes.tierA).toHaveLength(0);
  });

  test("the InputSnapshot is guarded too — §23.7 names it first, because replay consumes it", async () => {
    const store = capturingStore();
    await expect(
      decisionRecord.writeRound(
        { prisma: store.prisma },
        roundOf({ snapshot: { snapshotId: "snap-1", hash: "h", pins: { recipientName: "A. Person" } } }),
      ),
    ).rejects.toThrow(/an InputSnapshot row holds identifying value\(s\)/);

    // Refused before the row reaches the store, so no partial write survives.
    expect(store.writes.snapshots).toHaveLength(0);
    expect(store.writes.tierA).toHaveLength(0);
  });

  test("the surrogate key itself is exempt — the column that fixes the problem is not the problem", () => {
    const row = tierA.toRow(minimalTierARecord(), { surrogateKeys: ["sk_stop_" + "a".repeat(32)] });
    expect(() => surrogateKeysModule.assertNonIdentifying(row, "a Tier A row")).not.toThrow();
    expect(row.surrogateKeys).toEqual(["sk_stop_" + "a".repeat(32)]);
  });

  test("the guard is applied to all three tables the writer owns", () => {
    const source = sourceOf("src", "engine", "observability", "decisionRecord.js");
    expect(source).toMatch(/assertNonIdentifying\(snapshotData/);
    expect(source).toMatch(/assertNonIdentifying\(row/);
    expect(source).toMatch(/assertNonIdentifying\(tierBRow/);
  });
});

describe("P14-R13 — the erasure gate enforces §23.7's storage rule, not only its cost rule", () => {
  test("REPRODUCTION — an identifying value stored in a Tier A record fails the gate even though no cost read it", () => {
    const gate = require("../../tools/replay/replayDecision");
    const clean = gate.runCorpus({ erased: true });
    expect({ ok: clean.ok, stored: clean.failures.length }).toEqual({ ok: true, stored: 0 });

    // The gate's own scope: a Tier A section that no cost consumes. Before this
    // remediation the run reported `erasedFields: 1` and passed.
    const planted = gate.runCorpus({
      erased: true,
      corpus: [
        {
          name: "planted",
          tierA: { decisionId: "d1", leg: { legId: "leg-a", label: "12 Acacia Avenue" } },
          tierB: null,
          reconstructionInput: {},
        },
      ],
    });
    const stored = planted.failures.filter((f) => f.reason === "IDENTIFYING_VALUE_STORED_IN_A_DECISION_RECORD");
    expect(stored).toHaveLength(1);
    expect(stored[0].path).toBe("tierA.leg.label");
    expect(planted.ok).toBe(false);
  });

  test("an identifying field outside a decision record is reported and not failed on", () => {
    const gate = require("../../tools/replay/replayDecision");
    const planted = gate.runCorpus({
      erased: true,
      corpus: [
        {
          name: "harness-input",
          tierA: { decisionId: "d1", leg: { legId: "leg-a" } },
          tierB: null,
          // §23.7 binds "decision records and input snapshots". The replay harness's own
          // input bundle is neither, so this is information and not a violation.
          reconstructionInput: { stop: { label: "12 Acacia Avenue" } },
        },
      ],
    });
    expect(planted.failures.filter((f) => f.reason === "IDENTIFYING_VALUE_STORED_IN_A_DECISION_RECORD")).toHaveLength(0);
    expect(planted.erasedFields.some((f) => f.path.startsWith("reconstructionInput"))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R8 / P14-R9 — the session namespace and the binding assertion
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R8 — a certificate binding is never accepted as a bearer token", () => {
  const { __testing } = requireRobotHandlerTestSurface();

  test("REPRODUCTION — a stored binding is refused as a credential", () => {
    const binding = JSON.stringify({
      agentId: "AGT-1",
      fingerprint: "a".repeat(64),
      sessionId: "sock-1",
      certificateId: "11111111-1111-4111-8111-111111111111",
      establishedAtMs: 1,
      lastRevocationCheckAtMs: 1,
      nextRevocationCheckAtMs: 2,
      expiresAtMs: null,
    });
    // Before this fix, an agent that connected without a certificate could present this
    // exact string as `token` and the legacy branch would compare it equal to the stored
    // value and authenticate. The binding is not a secret: it names a certificate
    // fingerprint, which is public.
    expect(__testing.isCertificateBinding(binding)).toBe(true);
    expect(__testing.isCertificateBinding({ fingerprint: "a", sessionId: "b" })).toBe(true);
  });

  test("an ordinary bearer token is unaffected", () => {
    expect(__testing.isCertificateBinding("11111111-1111-4111-8111-111111111111")).toBe(false);
    expect(__testing.isCertificateBinding("")).toBe(false);
    expect(__testing.isCertificateBinding(null)).toBe(false);
    expect(__testing.isCertificateBinding(undefined)).toBe(false);
    // Malformed JSON is a token, not a binding — and must not throw.
    expect(__testing.isCertificateBinding("{not json")).toBe(false);
    // JSON that is not a binding is still not a credential-shaped binding.
    expect(__testing.isCertificateBinding('{"hello":"world"}')).toBe(false);
  });

  test("the handler refuses it by name rather than falling through silently", () => {
    const source = sourceOf("src", "sockets", "handlers", "robot.handler.js");
    expect(source).toMatch(/isCertificateBinding\(storedSession\)/);
    // The refusal message lives in a string literal, which `codeOnly()` blanks, so it is
    // asserted against the raw file.
    const raw = fs.readFileSync(path.join(BACKEND_ROOT, "src", "sockets", "handlers", "robot.handler.js"), "utf8");
    expect(raw).toMatch(/Stored session value is a certificate binding/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R14 — §23.5 row 3 is decided by §23.5's own module and raises an event
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R14 — a completion claim from an unreachable position raises a security event", () => {
  test("REPRODUCTION — `validateCompletion()` now has a production caller", () => {
    const source = sourceOf("src", "sockets", "handlers", "dtaro.handler.js");
    // The plan's Phase 14 testing requirements name this outcome: "a completion claim from
    // a kinematically unreachable position is rejected and raises a security event". Phase
    // 5's own `verification.verify()` set and logged `securityEvent`; §23.5's module — the
    // one the trust-boundary table binds — decided nothing, because nothing called it.
    expect(source).toMatch(/trustBoundaries\.validateCompletion\(/);
    expect(source).toMatch(/trustBoundaries\.validatePosition\(/);
  });

  test("the event is broadcast, not only logged", () => {
    const raw = fs.readFileSync(path.join(BACKEND_ROOT, "src", "sockets", "handlers", "dtaro.handler.js"), "utf8");
    expect(raw).toMatch(/UNREACHABLE_COMPLETION_CLAIM/);
    // The same room and the same event name persistent implausibility already uses, so a
    // dashboard that handles one handles both.
    expect(raw).toMatch(/io\.to\("dashboard"\)\.emit\("SECURITY_EVENT"/);
  });

  test("the module's verdict is the one §23.5 states: a failed verification from an unreachable place is a security event", () => {
    const unreachable = trustBoundaries.validatePosition({
      last: { lat: 51.5, lon: -0.1, atMs: 1_000_000 },
      reported: { lat: 52.5, lon: -1.1, atMs: 1_060_000 },
      maxSpeedMps: 5,
      tolerance: 1.2,
    });
    expect(unreachable.securityEvent).toBe(true);

    const verdict = trustBoundaries.validateCompletion({ verification: { verified: true }, positionCheck: unreachable });
    expect(verdict.securityEvent).toBe(true);
    expect(verdict.verdict).toBe(trustBoundaries.VERDICT.REJECTED);
  });

  test("a reachable completion raises nothing", () => {
    const reachable = trustBoundaries.validatePosition({
      last: { lat: 51.5, lon: -0.1, atMs: 1_000_000 },
      reported: { lat: 51.5001, lon: -0.1001, atMs: 1_060_000 },
      maxSpeedMps: 5,
      tolerance: 1.2,
    });
    const verdict = trustBoundaries.validateCompletion({ verification: { verified: true }, positionCheck: reachable });
    expect(verdict.securityEvent).toBe(false);
    expect(verdict.verdict).toBe(trustBoundaries.VERDICT.ACCEPTED);
  });

  test("the ceiling is the threshold the completion path already reads — no number is invented", () => {
    const source = sourceOf("src", "sockets", "handlers", "dtaro.handler.js");
    expect(source).toMatch(/maxSpeedMps: thresholds\.maxSpeedMs/);
    // The parameter name is a string literal, which `codeOnly()` blanks.
    const raw = fs.readFileSync(path.join(BACKEND_ROOT, "src", "sockets", "handlers", "dtaro.handler.js"), "utf8");
    expect(raw).toMatch(/security\.position_plausibility_tolerance/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P14-R15 — §23.5's asymmetric health rule reaches the telemetry status path
// ───────────────────────────────────────────────────────────────────────────

describe("P14-R15 — a self-report may restrict an agent, never expand it", () => {
  test("REPRODUCTION — the transition table alone lets an agent clear its own fault", () => {
    const raw = fs.readFileSync(path.join(BACKEND_ROOT, "src", "sockets", "handlers", "telemetry.handler.js"), "utf8");
    // The table itself is unchanged and still admits the transition — this is not a
    // narrowing of the legacy state machine.
    expect(raw).toMatch(/ERROR:\s*new Set\(\["IDLE", "ACTIVE", "OFFLINE", "ISSUES"\]\)/);
    // What is added is the §23.5 verdict alongside it.
    expect(raw).toMatch(/trustBoundaries\.validateHealth\(/);
    expect(raw).toMatch(/an agent may declare itself unfit, never fit/);
  });

  test("the direction is computed from the legacy status, not invented", () => {
    const source = sourceOf("src", "sockets", "handlers", "telemetry.handler.js");
    expect(source).toMatch(/reportedTier: healthTierOf\(statusDb\)/);
    expect(source).toMatch(/currentTier: healthTierOf\(cur\)/);
  });

  test("ERROR → IDLE is an EXPANDING self-report and is not applied", () => {
    // ERROR is tier 0 (no work may be given); IDLE is tier 2 (unrestricted).
    const verdict = trustBoundaries.validateHealth({ reportedTier: 2, currentTier: 0 });
    expect(verdict.direction).toBe(trustBoundaries.DIRECTION.EXPANDING);
    expect(verdict.applied).toBe(false);
    expect(verdict.verdict).toBe(trustBoundaries.VERDICT.ACCEPTED_RESTRICTING_ONLY);
    expect(verdict.reasons.join(" ")).toMatch(/self-reported fitness is not trusted/);
  });

  test("ACTIVE → ERROR is RESTRICTING and is applied — an agent may always declare itself unfit", () => {
    const verdict = trustBoundaries.validateHealth({ reportedTier: 0, currentTier: 2 });
    expect(verdict.direction).toBe(trustBoundaries.DIRECTION.RESTRICTING);
    expect(verdict.applied).toBe(true);
  });

  test("a status outside the enum is NEUTRAL — unknown is neither an expansion nor a restriction", () => {
    const verdict = trustBoundaries.validateHealth({ reportedTier: null, currentTier: 2 });
    expect(verdict.direction).toBe(trustBoundaries.DIRECTION.NEUTRAL);
    expect(verdict.applied).toBe(true);
  });

  test("it is staged the way §23.5's position and energy rows already are: logged now, enforced at cutover", () => {
    const source = sourceOf("src", "sockets", "handlers", "telemetry.handler.js");
    // The refusal takes effect only when the engine is live, which is the identical
    // disposition the position and energy rows carry — not a new staging rule.
    //
    // PHASE 15 remediation (D-6) — "live" is now resolved per **shard** rather than per
    // process, so `engineEnabled()` takes the session and the published snapshot. The P14
    // staging property is unchanged and strictly narrower: a self-report that would expand
    // eligibility is still refused exactly when the engine is the decision path, and that
    // is now the two-half conjunction §22.4 stages rather than the deployment-wide flag.
    expect(source).toMatch(/if \(health\.applied \|\| !engineEnabled\(socket, configOf\(\)\)\)/);
    // The staging is read through the module that owns the switch, not re-derived here.
    expect(source).toMatch(/agentGate\.mayAct\(/);
    expect(source).not.toMatch(/process\.env\.ENGINE_ENABLED/);
  });
});

describe("P14-R9 — `assertBound()` has a production caller", () => {
  test("REPRODUCTION — the heartbeat path asserts the three-component binding", () => {
    const source = sourceOf("src", "sockets", "handlers", "robot.handler.js");
    expect(source).toMatch(/sessionBinding\.assertBound\(binding, \{/);
    // All three components, which is the point: two would catch an accident, three catch
    // a genuine session for agent A replayed to speak about agent B.
    expect(source).toMatch(/agentId: socket\.data\.robotId/);
    expect(source).toMatch(/sessionId: binding\.sessionId/);
    expect(source).toMatch(/fingerprint: binding\.fingerprint/);
  });

  test("the certificate worker's session provider is no longer a stub returning nothing", () => {
    const source = sourceOf("server.js");
    expect(source).not.toMatch(/sessions:\s*async\s*\(\)\s*=>\s*\[\]/);
    expect(source).toMatch(/socket\.data\.certificateBinding/);
  });
});

/**
 * The robot handler exports its registration function only. The two pure predicates this
 * file exercises are re-derived here from the module's own source rather than by widening
 * its export surface for a test — a test that forces a module to publish more than it
 * needs to is a test that has changed the thing it measures.
 */
function requireRobotHandlerTestSurface() {
  const raw = fs.readFileSync(path.join(BACKEND_ROOT, "src", "sockets", "handlers", "robot.handler.js"), "utf8");
  const start = raw.indexOf("function isCertificateBinding(");
  expect(start).toBeGreaterThan(-1);
  // The function body ends at the first line that closes it at column zero.
  const end = raw.indexOf("\n}\n", start) + 3;
  // eslint-disable-next-line no-new-func
  const isCertificateBinding = new Function(`${raw.slice(start, end)}\nreturn isCertificateBinding;`)();
  return { __testing: { isCertificateBinding } };
}

/** A Tier A record with only the fields `toRow` reads. */
function minimalTierARecord() {
  return {
    identity: { decisionId: "d1", roundId: "r1", shardId: "s1", leadershipFence: null, coordinatorInstance: null, decisionTimeMs: 1 },
    versions: {},
    trigger: "NEW_ARRIVAL",
    inputSnapshotRefs: {},
    leg: { legId: "leg-a" },
    outcome: {},
    runnerUpAndTopN: [],
    costTotals: null,
    rejectionSummary: [],
    searchAndSolveBounds: {},
    degradation: {},
    deferral: null,
    overrides: [],
    predictions: null,
  };
}

/** A Tier B record with only the fields `toRow` reads. */
function minimalTierBRecord() {
  return {
    decisionId: "d1",
    roundId: "r1",
    shardId: "s1",
    decisionTimeMs: 1,
    candidateSet: [],
    feasibility: [],
    costs: [],
    columnDetail: [],
    contentHash: "h",
  };
}
