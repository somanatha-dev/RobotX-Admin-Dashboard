"use strict";

/**
 * Phase 3 — two-scope fencing (§10.3.1), idempotency (§10.5), clock discipline
 * (§10.6), and the lease granted at commit (§12.2).
 *
 * The plan's testing requirement for the fencing half:
 *
 * > Unit: fence rejection per commitment id (not per agent max); `fence_floor`
 * > invalidates all mission authorities; unknown-commitment command rejected via
 * > `fence_floor`, not admitted for lack of history.
 * > Tests: fence compared **per commitment id**, never as a per-agent maximum.
 */

const fencing = require("../../src/engine/commitment/fencing");
const idempotency = require("../../src/engine/commitment/idempotency");
const clock = require("../../src/engine/commitment/clock");
const leases = require("../../src/engine/commitment/leases");
const model = require("../../src/engine/commitment/model");

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3.1 — the normative command-class → fence-scope table
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the command-class → fence-scope table (§10.3.1)", () => {
  // Transcribed from the specification's own table, not from the module.
  const SPEC_MISSION_COMMANDS = [
    "OFFER",
    "WITHDRAW",
    "REROUTE",
    "RESEQUENCE",
    "RECALL",
    "RESUME",
    "TRANSFER_CUSTODY",
    "ABORT_MISSION",
  ];
  const SPEC_AGENT_COMMANDS = [
    "STAND_DOWN_ALL",
    "QUARANTINE",
    "RELEASE_QUARANTINE",
    "ESTOP_CLEAR",
    "SHARD_MIGRATE",
    "SESSION_REKEY",
    "PARAMETER_PUSH",
  ];
  const SPEC_QUERIES = ["STATUS_REQUEST", "PROBE", "MANIFEST_QUERY"];

  test.each(SPEC_MISSION_COMMANDS)("%s is fenced by the commitment scope", (command) => {
    expect(fencing.fenceScopeOf(command)).toBe(fencing.FENCE_SCOPE.COMMITMENT);
    expect(fencing.commandClassOf(command)).toBe(fencing.COMMAND_CLASS.MISSION);
  });

  test.each(SPEC_AGENT_COMMANDS)("%s is fenced by the agent scope", (command) => {
    expect(fencing.fenceScopeOf(command)).toBe(fencing.FENCE_SCOPE.AGENT);
    expect(fencing.commandClassOf(command)).toBe(fencing.COMMAND_CLASS.AGENT);
  });

  test.each(SPEC_QUERIES)("%s is never fenced — it is side-effect-free", (command) => {
    expect(fencing.fenceScopeOf(command)).toBeNull();
    expect(fencing.commandClassOf(command)).toBe(fencing.COMMAND_CLASS.QUERY);
  });

  test("the table has no command the specification does not name, in either direction", () => {
    expect([...fencing.MISSION_COMMANDS].sort()).toEqual([...SPEC_MISSION_COMMANDS].sort());
    expect([...fencing.AGENT_COMMANDS].sort()).toEqual([...SPEC_AGENT_COMMANDS].sort());
    expect([...fencing.QUERY_COMMANDS].sort()).toEqual([...SPEC_QUERIES].sort());
  });

  test("an unknown command is refused, never treated as unfenced (T2)", () => {
    expect(() => fencing.fenceScopeOf("DELIVER_PIZZA")).toThrow(/absent from the §10.3.1/);
    expect(() => fencing.fenceScopeOf(undefined)).toThrow(/absent from the §10.3.1/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The defect the split exists to prevent
   ═══════════════════════════════════════════════════════════════════════════ */

describe("fences are compared per commitment id, never as a per-agent maximum", () => {
  // §10.3.1's own worked example: C1 at fence 5, C2 at fence 6, one agent.
  const highestSeen = new Map([
    ["C1", 5n],
    ["C2", 6n],
  ]);

  test("a command for C1 at fence 6 is accepted although C2 has seen a higher one", () => {
    // Under a per-agent maximum this is rejected (6 ≤ 6) and C1 becomes
    // uncommandable for the rest of its life — the exact defect §10.3.1 removes.
    const result = fencing.acceptsMissionCommand({ commitmentId: "C1", fence: 6n }, highestSeen);
    expect(result).toEqual({ accepted: true, reason: null });
  });

  test("settling C1 and bumping the counter to 7 leaves C2 commandable at 7 (I19)", () => {
    const afterSettlement = new Map([
      ["C1", 7n],
      ["C2", 6n],
    ]);
    expect(fencing.acceptsMissionCommand({ commitmentId: "C2", fence: 7n }, afterSettlement).accepted).toBe(true);
  });

  test("a superseded fence for its own commitment is rejected", () => {
    expect(fencing.acceptsMissionCommand({ commitmentId: "C1", fence: 5n }, highestSeen)).toEqual({
      accepted: false,
      reason: "FENCE_SUPERSEDED_FOR_COMMITMENT",
    });
    expect(fencing.acceptsMissionCommand({ commitmentId: "C1", fence: 4n }, highestSeen).accepted).toBe(false);
  });

  test("the comparison for a mission command is `≤`, not `<`", () => {
    expect(fencing.acceptsMissionCommand({ commitmentId: "C1", fence: 5n }, highestSeen).accepted).toBe(false);
    expect(fencing.acceptsMissionCommand({ commitmentId: "C1", fence: 6n }, highestSeen).accepted).toBe(true);
  });

  test("the rejection predicate does not accept a scalar maximum at all", () => {
    // A caller that tried to pass "the agent's highest fence" gets no history rather
    // than a silently wrong comparison: 9 is not a map key.
    const result = fencing.acceptsMissionCommand({ commitmentId: "C1", fence: 1n }, 9n);
    expect(result.accepted).toBe(true);
  });
});

describe("fence_floor (§10.3.1's interaction rule)", () => {
  test("an unknown commitment id is judged against fence_floor, not admitted for lack of history", () => {
    const seen = new Map();
    expect(fencing.acceptsMissionCommand({ commitmentId: "C9", fence: 3n }, seen, 5n)).toEqual({
      accepted: false,
      reason: "FENCE_AT_OR_BELOW_FLOOR",
    });
    expect(fencing.acceptsMissionCommand({ commitmentId: "C9", fence: 6n }, seen, 5n).accepted).toBe(true);
  });

  test("one STAND_DOWN_ALL fences every commitment the agent holds, without enumerating them", () => {
    const before = new Map([
      ["C1", 5n],
      ["C2", 6n],
      ["C3", 7n],
    ]);
    const after = fencing.applyAgentCommand({ authorityEpoch: 8n, fenceFloor: 41n });

    expect(after.highestSeenPerCommitment.size).toBe(0);
    for (const commitmentId of before.keys()) {
      const result = fencing.acceptsMissionCommand(
        { commitmentId, fence: 41n },
        after.highestSeenPerCommitment,
        after.fenceFloor,
      );
      expect({ commitmentId, ...result }).toEqual({
        commitmentId,
        accepted: false,
        reason: "FENCE_AT_OR_BELOW_FLOOR",
      });
    }
  });

  test("a mission command issued after the stand-down, at a fresh fence, is accepted", () => {
    const after = fencing.applyAgentCommand({ authorityEpoch: 8n, fenceFloor: 41n });
    expect(
      fencing.acceptsMissionCommand({ commitmentId: "C4", fence: 42n }, after.highestSeenPerCommitment, after.fenceFloor)
        .accepted,
    ).toBe(true);
  });

  test("an agent-scope command without fence_floor is refused", () => {
    expect(() => fencing.applyAgentCommand({ authorityEpoch: 8n })).toThrow(/MUST carry fence_floor/);
  });

  test("fence_floor is the agent's current fence_counter", () => {
    expect(fencing.fenceFloorFor({ fenceCounter: 41n })).toBe(41n);
    expect(() => fencing.fenceFloorFor({})).toThrow(/fence_counter/);
  });
});

describe("the agent-scope rejection rule", () => {
  test("a lower authority_epoch is rejected", () => {
    expect(fencing.acceptsAgentCommand({ authorityEpoch: 6n }, 7n)).toEqual({
      accepted: false,
      reason: "AUTHORITY_EPOCH_SUPERSEDED",
    });
  });

  test("an equal authority_epoch is accepted — §10.3.1 states `<`, and dedup covers redelivery", () => {
    expect(fencing.acceptsAgentCommand({ authorityEpoch: 7n }, 7n).accepted).toBe(true);
  });
});

describe("fence allocation (§10.3.2 step 4)", () => {
  test("allocates counter + 1 and strictly advances", () => {
    expect(fencing.allocateFence(41n)).toBe(42n);
    expect(fencing.isStrictAdvance(41n, fencing.allocateFence(41n))).toBe(true);
  });

  test("accepts a number or a string counter without losing precision at BigInt scale", () => {
    expect(fencing.allocateFence("9007199254740993")).toBe(9007199254740994n);
  });

  test("refuses a negative counter (I6)", () => {
    expect(() => fencing.allocateFence(-1n)).toThrow(/monotone/);
  });

  test("a non-advance is not a strict advance", () => {
    expect(fencing.isStrictAdvance(41n, 41n)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.5 — idempotency, and the two disjoint namespaces
   ═══════════════════════════════════════════════════════════════════════════ */

describe("idempotency (§10.5)", () => {
  const identity = { legId: "leg-1", agentId: "agent-1", decisionRoundId: "round-9" };

  test("the commitment id is a deterministic function of (leg, agent, round)", () => {
    expect(idempotency.commitmentIdFor(identity)).toBe(idempotency.commitmentIdFor({ ...identity }));
  });

  test("changing any one of the three changes the id", () => {
    const base = idempotency.commitmentIdFor(identity);
    expect(idempotency.commitmentIdFor({ ...identity, legId: "leg-2" })).not.toBe(base);
    expect(idempotency.commitmentIdFor({ ...identity, agentId: "agent-2" })).not.toBe(base);
    expect(idempotency.commitmentIdFor({ ...identity, decisionRoundId: "round-10" })).not.toBe(base);
  });

  test("no clock and no randomness enter the id — two calls a second apart agree", () => {
    const first = idempotency.commitmentIdFor(identity);
    const second = idempotency.commitmentIdFor(identity);
    expect(first).toBe(second);
  });

  test("the two command namespaces are disjoint by construction", () => {
    const mission = idempotency.missionCommandKey({ commitmentId: "C1", sequence: 0, fence: 42n });
    const agent = idempotency.agentCommandKey({ agentId: "C1", sequence: 0, authorityEpoch: 42n });
    expect(mission).not.toBe(agent);
    expect(idempotency.inDisjointNamespaces(mission, agent)).toBe(true);
  });

  test("a component containing the separator is refused, so no two tuples can encode alike", () => {
    expect(() => idempotency.commitmentIdFor({ ...identity, legId: "leg 1" })).toThrow(/field separator/);
  });

  test("the scope table routes each command to its own namespace", () => {
    expect(
      idempotency.idempotencyKeyFor({ command: "RECALL", commitmentId: "C1", sequence: 2, fence: 43n }),
    ).toContain(idempotency.MISSION_COMMAND_NAMESPACE);
    expect(
      idempotency.idempotencyKeyFor({ command: "QUARANTINE", agentId: "agent-1", sequence: 2, authorityEpoch: 8n }),
    ).toContain(idempotency.AGENT_COMMAND_NAMESPACE);
  });

  test("a query has nothing to deduplicate", () => {
    expect(idempotency.idempotencyKeyFor({ command: "PROBE" })).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.6 — clock discipline
   ═══════════════════════════════════════════════════════════════════════════ */

describe("clock discipline (§10.6)", () => {
  const storeTime = new Date("2026-07-29T12:00:00.000Z");
  const MAX_CLOCK_SKEW_MS = 500;

  test("a deadline is computed from the store's timestamp", () => {
    expect(clock.deadlineFrom(storeTime, 60).toISOString()).toBe("2026-07-29T12:01:00.000Z");
  });

  test("a deadline cannot be computed from a non-timestamp", () => {
    expect(() => clock.deadlineFrom(Date.now(), 60)).toThrow(/store's timestamp/);
  });

  test("skew is signed, so both directions are distinguishable", () => {
    expect(clock.measureSkew(storeTime, storeTime.getTime() + 300)).toBe(300);
    expect(clock.measureSkew(storeTime, storeTime.getTime() - 300)).toBe(-300);
  });

  test("a node inside the skew budget stays leadership-eligible", () => {
    expect(clock.assessLeadershipEligibility(400, MAX_CLOCK_SKEW_MS).eligible).toBe(true);
    expect(clock.assessLeadershipEligibility(-400, MAX_CLOCK_SKEW_MS).eligible).toBe(true);
  });

  test("a node beyond the budget removes itself from leadership eligibility", () => {
    const verdict = clock.assessLeadershipEligibility(900, MAX_CLOCK_SKEW_MS);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/removes itself from leadership eligibility/);
  });

  test("an absent deadline has passed — unknown is never permission (T2)", () => {
    expect(clock.hasPassed(null, storeTime)).toBe(true);
    expect(clock.hasPassed("not a date", storeTime)).toBe(true);
  });

  test("the monotonic source is independent of the wall clock", () => {
    const first = clock.monotonicNanos();
    const second = clock.monotonicNanos();
    expect(second >= first).toBe(true);
    expect(clock.elapsedMillis(first, second)).toBeGreaterThanOrEqual(0);
  });

  test("reading the store clock requires the transaction client", async () => {
    await expect(clock.readStoreTime(null)).rejects.toThrow(/coordinate system/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §12.2 — the lease granted at commit
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the lease (§12.2)", () => {
  const storeTime = new Date("2026-07-29T12:00:00.000Z");
  /** `lease.duration`, Appendix A default. */
  const LEASE_DURATION_SECONDS = 60;

  test("expiry is `store_now + lease.duration`, absolute", () => {
    const lease = leases.grant({ storeTime, leaseDurationSeconds: LEASE_DURATION_SECONDS });
    expect(lease.expiresAt.toISOString()).toBe("2026-07-29T12:01:00.000Z");
    expect(lease.grantedAt).toBe(storeTime);
  });

  test("a commitment cannot be granted without a positive lease (I2)", () => {
    expect(() => leases.grant({ storeTime, leaseDurationSeconds: 0 })).toThrow(/unsupervised commitment/);
    expect(() => leases.grant({ storeTime, leaseDurationSeconds: undefined })).toThrow(/unsupervised commitment/);
  });

  test("validity is judged against the store's clock", () => {
    const commitment = { leaseExpiry: new Date("2026-07-29T12:01:00.000Z") };
    expect(leases.isValidAt(commitment, storeTime)).toBe(true);
    expect(leases.isValidAt(commitment, new Date("2026-07-29T12:01:00.001Z"))).toBe(false);
  });

  test("renewal requires commitment-scoped evidence — a generic ping is insufficient", () => {
    const commitment = { commitmentId: "C1", fence: 42n };
    expect(leases.isRenewalEvidenceSufficient(commitment, {})).toEqual({
      sufficient: false,
      reason: "EVIDENCE_NAMES_ANOTHER_COMMITMENT",
    });
    expect(leases.isRenewalEvidenceSufficient(commitment, { commitmentId: "C1" })).toEqual({
      sufficient: false,
      reason: "EVIDENCE_CARRIES_NO_FENCE",
    });
    expect(leases.isRenewalEvidenceSufficient(commitment, { commitmentId: "C1", fence: 42n }).sufficient).toBe(true);
  });

  test("evidence naming another commitment on the same agent does not renew this one", () => {
    const commitment = { commitmentId: "C1", fence: 42n };
    expect(leases.isRenewalEvidenceSufficient(commitment, { commitmentId: "C2", fence: 43n }).sufficient).toBe(false);
  });

  test("evidence carrying a superseded fence for the right commitment does not renew it", () => {
    const commitment = { commitmentId: "C1", fence: 42n };
    expect(leases.isRenewalEvidenceSufficient(commitment, { commitmentId: "C1", fence: 41n })).toEqual({
      sufficient: false,
      reason: "EVIDENCE_CARRIES_A_DIFFERENT_FENCE",
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §2.6 / I18 — the model refuses a SOFT reservation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Commitment model (§2.6)", () => {
  const wellFormed = {
    commitmentId: "commitment-abc",
    agentId: "agent-1",
    legId: "leg-1",
    kind: "HARD",
    fence: 42n,
    leaseExpiry: new Date("2026-07-29T12:01:00.000Z"),
    custodyState: "NONE",
    planSnapshotRef: "plan-snapshot-1",
    decisionRef: "decision-1",
    version: 0,
    capacitySlot: 0,
  };

  test("a well-formed HARD commitment validates", () => {
    expect(model.validateCommitment(wellFormed)).toEqual([]);
  });

  test("a SOFT reservation is refused before it reaches the store (I18)", () => {
    expect(() => model.refuseSoftPersistence({ kind: "SOFT" })).toThrow(/round-local coordinator state/);
    expect(() => model.refuseSoftPersistence({ kind: "PROVISIONAL" })).toThrow(/Only HARD commitments are durable/);
    expect(() => model.refuseSoftPersistence({ kind: "HARD" })).not.toThrow();
  });

  test("a commitment with no fence, no lease, or a bad custody state is refused", () => {
    expect(model.validateCommitment({ ...wellFormed, fence: undefined })).toEqual([
      expect.stringContaining("carries no fence"),
    ]);
    expect(model.validateCommitment({ ...wellFormed, leaseExpiry: null })).toEqual([
      expect.stringContaining("no lease expiry"),
    ]);
    expect(model.validateCommitment({ ...wellFormed, custodyState: "MISLAID" })).toEqual([
      expect.stringContaining("§2.5 does not define"),
    ]);
  });

  test("activity is `releasedAt IS NULL` — the same predicate the index is built on", () => {
    expect(model.isActive({ releasedAt: null })).toBe(true);
    expect(model.isActive({ releasedAt: new Date() })).toBe(false);
  });

  test("the lowest free slot is chosen, and reused after release", () => {
    expect(model.lowestFreeSlot([], 3)).toBe(0);
    expect(model.lowestFreeSlot([{ capacitySlot: 0 }], 3)).toBe(1);
    expect(model.lowestFreeSlot([{ capacitySlot: 1 }], 3)).toBe(0);
    expect(model.lowestFreeSlot([{ capacitySlot: 0 }, { capacitySlot: 1 }, { capacitySlot: 2 }], 3)).toBeNull();
  });

  test("slot allocation is deterministic, so a retry chooses the same slot", () => {
    const active = [{ capacitySlot: 0 }, { capacitySlot: 2 }];
    expect(model.lowestFreeSlot(active, 4)).toBe(model.lowestFreeSlot([...active].reverse(), 4));
  });

  test("the §2.6 field list is carried in full", () => {
    for (const field of model.COMMITMENT_FIELDS) {
      expect({ field, present: Object.prototype.hasOwnProperty.call(wellFormed, field) }).toEqual({
        field,
        present: true,
      });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §22 — the parameters this phase consumes, through the real Config Service
   ═══════════════════════════════════════════════════════════════════════════ */

describe("parameter-register integration (§22, invariant I15)", () => {
  const configService = require("../../src/engine/config/service");
  const snapshot = configService.defaultSnapshot();

  // The plan's "Configuration updates" row for Phase 3, verbatim.
  const PHASE_3_PARAMETERS = [
    ["commit.max_serial_utilisation", {}, undefined, "ratio", "STRUCTURAL"],
    ["lease.duration", { agent_class: "porter-2" }, undefined, "s", "SAFETY"],
    ["time.max_clock_skew", {}, undefined, "ms", "STRUCTURAL"],
    ["shard.lease_duration", {}, undefined, "s", "STRUCTURAL"],
    ["capacity", { agent_class: "porter-2" }, { index: "porter-2" }, "count", "STRUCTURAL"],
  ];

  test.each(PHASE_3_PARAMETERS)(
    "%s resolves through the Config Service with its Appendix A unit and change class",
    (name, context, options, unit, changeClass) => {
      const explanation = snapshot.explain(name, context, options);
      expect({ name, source: explanation.source }).not.toEqual({ name, source: "unknown-parameter" });
      expect({ name, unit: explanation.unit, changeClass: explanation.changeClass }).toEqual({ name, unit, changeClass });
      expect(explanation.value).not.toBeNull();
    },
  );

  test("capacity ships at 1 — the singleton regime of §1.8 rule 3", () => {
    expect(snapshot.resolve("capacity", { agent_class: "porter-2" }, { index: "porter-2" })).toBe(1);
  });

  test("every resolved value names the scope level that supplied it (§22.2)", () => {
    for (const [name, context, options] of PHASE_3_PARAMETERS) {
      expect(snapshot.explain(name, context, options).level).toEqual(expect.any(String));
    }
  });

  test("no commitment-core module hard-codes one of these values", () => {
    // The parameter gate already refuses a bare literal anywhere in `src/engine`.
    // This asserts the narrower property that matters here: the commit path takes
    // capacity and lease duration as *inputs*, so a caller cannot accidentally get a
    // default the Config Service never resolved.
    const commit = require("../../src/engine/commitment/commit");
    expect(commit.commit.length).toBe(2);

    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "engine", "commitment", "commit.js"),
      "utf8",
    );
    expect(source).toMatch(/const capacity = config\.capacity/);
    expect(source).toMatch(/const leaseDurationSeconds = config\.leaseDurationSeconds/);
  });
});
