"use strict";

/**
 * Engine lane — Phase 4: the transactional outbox and per-command ordering.
 *
 * §11.1 (the outbox), §11.3 (ordering and bounded retry), §10.3.1 (the two fence
 * scopes as they appear in a row), §10.5 (the two disjoint idempotency namespaces),
 * §4.1 rule 5 (no side effect before its authorising write).
 *
 * The plan's Phase 4 gate: **"no command reaches an agent except from an outbox row
 * written in its authorising transaction."** The tests below establish both halves —
 * that a row cannot be written outside a transaction, and that a commit cannot happen
 * without writing one.
 */

const fencing = require("../../src/engine/commitment/fencing");
const idempotency = require("../../src/engine/commitment/idempotency");
const outbox = require("../../src/engine/dispatch/outbox");
const sequence = require("../../src/engine/dispatch/sequence");
const { commit } = require("../../src/engine/commitment/commit");

const fixtures = require("./helpers/dispatchFixture");

const HOUR_MS = 3600_000;

// Validity is expressed against the **store's** clock, not the host's — §10.6 makes
// the store's clock the single authority, and a fixture timed from `Date.now()` would
// be expired before the first claim whenever the two differ.
const STORE_NOW = fixtures.seed().now;
const VALID_FOR_AN_HOUR = new Date(STORE_NOW.getTime() + HOUR_MS);

function missionRow(overrides) {
  return {
    command: "OFFER",
    agentId: fixtures.AGENT_ROW_ID,
    commitmentId: "commitment-c1",
    fence: 42n,
    sequence: 0,
    payload: { legId: fixtures.LEG_ROW_ID },
    notValidAfter: VALID_FOR_AN_HOUR,
    signature: "deadbeef",
    ...(overrides || {}),
  };
}

function agentRow(overrides) {
  return {
    command: "STAND_DOWN_ALL",
    agentId: fixtures.AGENT_ROW_ID,
    authorityEpoch: 8n,
    fenceFloor: 41n,
    sequence: 0,
    payload: { reason: "operator" },
    notValidAfter: VALID_FOR_AN_HOUR,
    signature: "deadbeef",
    ...(overrides || {}),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3.1 — a row carries its own scope's columns, and never the other's
   ═══════════════════════════════════════════════════════════════════════════ */

describe("buildRow enforces the §10.3.1 scope discipline", () => {
  test("every mission command produces a COMMITMENT-scoped row", () => {
    for (const command of fencing.MISSION_COMMANDS) {
      const row = outbox.buildRow(missionRow({ command }));
      expect({ command, scope: row.fenceScope, klass: row.commandClass }).toEqual({
        command,
        scope: fencing.FENCE_SCOPE.COMMITMENT,
        klass: fencing.COMMAND_CLASS.MISSION,
      });
      expect({ command, authorityEpoch: row.authorityEpoch, fenceFloor: row.fenceFloor }).toEqual({
        command,
        authorityEpoch: null,
        fenceFloor: null,
      });
    }
  });

  test("every agent command produces an AGENT-scoped row", () => {
    for (const command of fencing.AGENT_COMMANDS) {
      const row = outbox.buildRow(agentRow({ command }));
      expect({ command, scope: row.fenceScope, klass: row.commandClass }).toEqual({
        command,
        scope: fencing.FENCE_SCOPE.AGENT,
        klass: fencing.COMMAND_CLASS.AGENT,
      });
      expect({ command, commitmentId: row.commitmentId, fence: row.fence }).toEqual({
        command,
        commitmentId: null,
        fence: null,
      });
    }
  });

  test("a query is refused — §10.3.1 row 3 makes it side-effect-free and unfenced", () => {
    for (const command of fencing.QUERY_COMMANDS) {
      expect(() => outbox.buildRow(missionRow({ command }))).toThrow(/query .*never fenced/i);
    }
  });

  test("an unknown command is refused rather than treated as unfenced", () => {
    expect(() => outbox.buildRow(missionRow({ command: "LAUNCH_MISSILES" }))).toThrow(/absent from the §10.3.1/);
  });

  test("a mission command without a commitment id or a fence is refused", () => {
    expect(() => outbox.buildRow(missionRow({ commitmentId: undefined }))).toThrow(/fenced per commitment id/);
    expect(() => outbox.buildRow(missionRow({ fence: undefined }))).toThrow(/MUST carry its commitment's fence/);
  });

  test("an agent command without fence_floor is refused — one STAND_DOWN_ALL must fence everything", () => {
    expect(() => outbox.buildRow(agentRow({ fenceFloor: undefined }))).toThrow(/fence_floor alongside authority_epoch/);
  });

  test("an agent command naming a commitment is refused", () => {
    expect(() => outbox.buildRow(agentRow({ commitmentId: "commitment-c1" }))).toThrow(/agent command/);
  });

  test("§23.3's envelope fields are mandatory", () => {
    expect(() => outbox.buildRow(missionRow({ notValidAfter: undefined }))).toThrow(/not_valid_after/);
    expect(() => outbox.buildRow(missionRow({ signature: "" }))).toThrow(/signature/);
    expect(() => outbox.buildRow(missionRow({ sequence: -1 }))).toThrow(/non-negative integer/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.5 — the two idempotency namespaces, on the row itself
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the row's idempotency key is in the right namespace (§10.5)", () => {
  test("a mission row is keyed on (commitment_id, sequence, fence)", () => {
    const row = outbox.buildRow(missionRow({ sequence: 3, fence: 44n }));
    expect(row.idempotencyKey).toBe(
      idempotency.missionCommandKey({ commitmentId: "commitment-c1", sequence: 3, fence: 44n }),
    );
  });

  test("an agent row is keyed on (agent_id, sequence, authority_epoch)", () => {
    const row = outbox.buildRow(agentRow({ sequence: 2, authorityEpoch: 9n }));
    expect(row.idempotencyKey).toBe(
      idempotency.agentCommandKey({ agentId: fixtures.AGENT_ROW_ID, sequence: 2, authorityEpoch: 9n }),
    );
  });

  test("the two namespaces cannot collide, whatever the contents", () => {
    const mission = outbox.buildRow(missionRow({ sequence: 1, fence: 5n }));
    const agent = outbox.buildRow(agentRow({ sequence: 1, authorityEpoch: 5n }));
    expect(idempotency.inDisjointNamespaces(mission.idempotencyKey, agent.idempotencyKey)).toBe(true);
    expect(mission.idempotencyKey).not.toBe(agent.idempotencyKey);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.1 rule 5 — the row is written in the authorising transaction
   ═══════════════════════════════════════════════════════════════════════════ */

describe("enqueue refuses to write outside a transaction (§4.1 rule 5)", () => {
  const fixture = fixtures.seed();

  test("the base client is refused", async () => {
    const store = fixtures.storeFor(fixture);
    await expect(outbox.enqueue(store.client, outbox.buildRow(missionRow()))).rejects.toThrow(
      /MUST be written inside the transaction that authorises the command/,
    );
  });

  test("a transaction client is accepted", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const written = await store.client.$transaction((tx) => outbox.enqueue(tx, outbox.buildRow(missionRow())));
    expect(written.state).toBe(outbox.OUTBOX_STATE.PENDING);
    expect(store.rows("outbox")).toHaveLength(1);
  });

  test("`isTransactionClient` tells the two apart by the presence of $transaction", () => {
    const store = fixtures.storeFor(fixture);
    expect(outbox.isTransactionClient(store.client)).toBe(false);
    expect(outbox.isTransactionClient({ outbox: {}, $transaction: undefined })).toBe(true);
  });

  test("a re-enqueue of the same command returns the same row, never a second obligation", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const row = outbox.buildRow(missionRow());
    const first = await store.client.$transaction((tx) => outbox.enqueue(tx, row));
    const second = await store.client.$transaction((tx) => outbox.enqueue(tx, row));
    expect(second.id).toBe(first.id);
    expect(store.rows("outbox")).toHaveLength(1);
  });
});

describe("commit refuses to run without an outbox writer — the Phase 4 gate", () => {
  const fixture = fixtures.seed();

  test("an absent sideEffects seam throws, symmetrically with volatileRecheck", async () => {
    const store = fixtures.storeFor(fixture);
    const deps = fixtures.commitDeps(store);
    delete deps.sideEffects;
    await expect(commit(deps, fixtures.commitRequest(fixture))).rejects.toThrow(/requires an outbox writer/);
  });

  test("the writer receives the locked rows' ids, not the request's", async () => {
    const store = fixtures.storeFor(fixture);
    let seen = null;
    await commit(
      fixtures.commitDeps(store, {
        sideEffects: async (tx, context) => {
          seen = context;
        },
      }),
      fixtures.commitRequest(fixture),
    );
    expect({ agentRowId: seen.agentRowId, legRowId: seen.legRowId }).toEqual({
      agentRowId: fixture.agent.id,
      legRowId: fixture.legs[0].id,
    });
    // The business identifiers are genuinely different in this fixture, so the
    // assertion above is not satisfied by coincidence — which was the Phase 3
    // verification's point.
    expect(fixture.agent.id).not.toBe(fixture.agent.agentId);
    expect(fixture.legs[0].id).not.toBe(fixture.legs[0].legId);
  });

  test("a caller passing the business identifier is told exactly that", async () => {
    const store = fixtures.storeFor(fixture);
    const result = await commit(
      fixtures.commitDeps(store),
      fixtures.commitRequest(fixture, { agentId: fixture.agent.agentId }),
    );
    expect(result.reason).toBe("AGENT_ID_IS_A_BUSINESS_KEY");
    expect(result.detail).toMatch(/its id is "11111111-1111-4111-8111-111111111111"/);
  });

  test("a genuinely missing row still reports a plain not-found", async () => {
    const store = fixtures.storeFor(fixture);
    const result = await commit(
      fixtures.commitDeps(store),
      fixtures.commitRequest(fixture, { agentId: "no-such-agent" }),
    );
    expect(result.reason).toBe("AGENT_NOT_FOUND");
  });

  test("a failing outbox write rolls the whole commit back — no commitment, no fence advance", async () => {
    const store = fixtures.storeFor(fixture);
    await expect(
      commit(
        fixtures.commitDeps(store, {
          sideEffects: async () => {
            throw new Error("outbox unavailable");
          },
        }),
        fixtures.commitRequest(fixture),
      ),
    ).rejects.toThrow(/outbox unavailable/);

    expect(store.rows("commitment")).toHaveLength(0);
    expect(store.rows("outbox")).toHaveLength(0);
    expect(store.rows("agent")[0].fenceCounter).toBe(41n);
    expect(store.rows("leg")[0].state).toBe("PLANNED");
    expect(store.rows("leg")[0].version).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.1 item 2 — claim, deliver, retry
   ═══════════════════════════════════════════════════════════════════════════ */

describe("claiming and recording attempts", () => {
  const fixture = fixtures.seed();

  function seededStore() {
    return fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
  }

  async function seedRow(store, overrides) {
    return store.client.$transaction((tx) => outbox.enqueue(tx, outbox.buildRow(missionRow(overrides))));
  }

  test("a PENDING row is claimed exactly once", async () => {
    const store = seededStore();
    await seedRow(store);

    const first = await outbox.claim(store.client, {
      workerId: "w1",
      storeTime: store.now(),
      limit: 10,
      claimTtlSeconds: 20,
    });
    const second = await outbox.claim(store.client, {
      workerId: "w2",
      storeTime: store.now(),
      limit: 10,
      claimTtlSeconds: 20,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(store.rows("outbox")[0].claimedBy).toBe("w1");
  });

  test("an expired claim is reclaimable — a dead worker does not strand its rows", async () => {
    const store = seededStore();
    await seedRow(store);
    await outbox.claim(store.client, { workerId: "w1", storeTime: store.now(), limit: 10, claimTtlSeconds: 20 });

    store.advanceClock(21);
    const reclaimed = await outbox.claim(store.client, {
      workerId: "w2",
      storeTime: store.now(),
      limit: 10,
      claimTtlSeconds: 20,
    });

    expect(reclaimed).toHaveLength(1);
    expect(store.rows("outbox")[0].claimedBy).toBe("w2");
  });

  test("a row past not_valid_after is never claimed (§23.3)", async () => {
    const store = seededStore();
    await seedRow(store, { notValidAfter: new Date(store.now().getTime() + 10_000) });
    store.advanceClock(11);

    const claimed = await outbox.claim(store.client, {
      workerId: "w1",
      storeTime: store.now(),
      limit: 10,
      claimTtlSeconds: 20,
    });
    expect(claimed).toHaveLength(0);
  });

  test("a successful attempt marks DELIVERED; a failed one returns the row to PENDING and counts", async () => {
    const store = seededStore();
    const row = await seedRow(store);
    await outbox.claim(store.client, { workerId: "w1", storeTime: store.now(), limit: 10, claimTtlSeconds: 20 });

    const failed = await outbox.recordAttempt(store.client, {
      id: row.id,
      workerId: "w1",
      delivered: false,
      storeTime: store.now(),
      error: "AGENT_NOT_CONNECTED",
    });
    expect(failed).toBe(1);
    expect(store.rows("outbox")[0]).toMatchObject({
      state: outbox.OUTBOX_STATE.PENDING,
      attempts: 1,
      lastError: "AGENT_NOT_CONNECTED",
      claimedBy: null,
    });

    await outbox.claim(store.client, { workerId: "w1", storeTime: store.now(), limit: 10, claimTtlSeconds: 20 });
    await outbox.recordAttempt(store.client, { id: row.id, workerId: "w1", delivered: true, storeTime: store.now() });
    expect(store.rows("outbox")[0]).toMatchObject({ state: outbox.OUTBOX_STATE.DELIVERED, attempts: 2 });
  });

  test("a worker whose claim lapsed cannot overwrite the new holder's progress", async () => {
    const store = seededStore();
    const row = await seedRow(store);
    await outbox.claim(store.client, { workerId: "w1", storeTime: store.now(), limit: 10, claimTtlSeconds: 20 });
    store.advanceClock(21);
    await outbox.claim(store.client, { workerId: "w2", storeTime: store.now(), limit: 10, claimTtlSeconds: 20 });

    const stale = await outbox.recordAttempt(store.client, {
      id: row.id,
      workerId: "w1",
      delivered: true,
      storeTime: store.now(),
    });
    expect(stale).toBe(0);
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.CLAIMED);
  });

  test("the expiry sweep terminates rows past their validity, never resurrects them", async () => {
    const store = seededStore();
    await seedRow(store, { notValidAfter: new Date(store.now().getTime() + 5_000) });
    store.advanceClock(6);

    expect(await outbox.expirePastValidity(store.client, store.now())).toBe(1);
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.EXPIRED);
    // Terminal, and settlement refuses to move it back.
    expect(
      await outbox.settleRow(store.client, {
        id: store.rows("outbox")[0].id,
        state: outbox.OUTBOX_STATE.ACKED,
        storeTime: store.now(),
      }),
    ).toBe(0);
  });

  test("the two SLIs §11.1 names are readable from the day the outbox exists", async () => {
    const store = seededStore();
    await seedRow(store);
    store.advanceClock(30);

    const sli = await outbox.readSli(store.client, store.now());
    expect(sli.depth).toBe(1);
    expect(sli.oldestUndeliveredAgeSeconds).toBe(30);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.5 path 3 — suppression
   ═══════════════════════════════════════════════════════════════════════════ */

describe("suppression (§11.5 path 3)", () => {
  const fixture = fixtures.seed();

  test("every outstanding row for the agent is suppressed, terminal ones are left alone", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });

    await store.client.$transaction(async (tx) => {
      await outbox.enqueue(tx, outbox.buildRow(missionRow({ sequence: 0 })));
      await outbox.enqueue(tx, outbox.buildRow(missionRow({ sequence: 1 })));
    });
    const rows = store.rows("outbox");
    await outbox.settleRow(store.client, {
      id: rows[1].id,
      state: outbox.OUTBOX_STATE.ACKED,
      storeTime: store.now(),
    });

    const suppressed = await store.client.$transaction((tx) =>
      outbox.suppressOutstandingForAgent(tx, { agentId: fixture.agent.id, reason: "DEDUP_STATE_RESET" }),
    );

    expect(suppressed).toBe(1);
    const after = store.rows("outbox");
    expect(after.find((r) => r.sequence === 0).state).toBe(outbox.OUTBOX_STATE.SUPPRESSED);
    expect(after.find((r) => r.sequence === 1).state).toBe(outbox.OUTBOX_STATE.ACKED);
  });

  test("suppression refuses to run outside the transaction that advances the epoch", async () => {
    const store = fixtures.storeFor(fixture);
    await expect(
      outbox.suppressOutstandingForAgent(store.client, { agentId: fixture.agent.id, reason: "x" }),
    ).rejects.toThrow(/MUST share its transaction/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The schema backstops, driven WITHOUT the module that is supposed to prevent it
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 4 CHECK constraints reject writes that bypass buildRow", () => {
  const fixture = fixtures.seed();

  async function insertDirectly(row) {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const attempt = store.client.$transaction((tx) => tx.outbox.create({ data: row }));
    return { store, attempt };
  }

  const wellFormed = () => ({
    idempotencyKey: "mission-command commitment-c1 0 42",
    agentId: fixture.agent.id,
    commitmentId: "commitment-c1",
    commandClass: "MISSION",
    command: "OFFER",
    fenceScope: "COMMITMENT",
    fence: 42n,
    authorityEpoch: null,
    fenceFloor: null,
    sequence: 0,
    payload: {},
    notValidAfter: new Date(fixture.now.getTime() + HOUR_MS),
    signature: "sig",
    state: "PENDING",
    attempts: 0,
  });

  test("a well-formed direct write is accepted — the backstops are not simply refusing everything", async () => {
    const { store, attempt } = await insertDirectly(wellFormed());
    await attempt;
    expect(store.rows("outbox")).toHaveLength(1);
  });

  test("a mission row carrying an authority epoch is rejected", async () => {
    const { attempt } = await insertDirectly({ ...wellFormed(), authorityEpoch: 8n, fenceFloor: 41n });
    await expect(attempt).rejects.toThrow(/Outbox_fence_scope_columns/);
  });

  test("an agent row carrying a commitment id is rejected", async () => {
    const { attempt } = await insertDirectly({
      ...wellFormed(),
      commandClass: "AGENT",
      command: "QUARANTINE",
      fenceScope: "AGENT",
      fence: null,
      authorityEpoch: 8n,
      fenceFloor: 41n,
    });
    await expect(attempt).rejects.toThrow(/Outbox_fence_scope_columns/);
  });

  test("a QUERY class is rejected — §10.3.1 row 3 is never enqueued", async () => {
    const { attempt } = await insertDirectly({ ...wellFormed(), commandClass: "QUERY", command: "PROBE" });
    await expect(attempt).rejects.toThrow(/Outbox_command_class_known/);
  });

  test("a negative sequence and an unknown state are rejected", async () => {
    const negative = await insertDirectly({ ...wellFormed(), sequence: -1 });
    await expect(negative.attempt).rejects.toThrow(/Outbox_sequence_non_negative/);

    const unknown = await insertDirectly({ ...wellFormed(), state: "IN_FLIGHT" });
    await expect(unknown.attempt).rejects.toThrow(/Outbox_state_known/);
  });

  test("a duplicate idempotency key is rejected by the unique index, not by application logic", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    await store.client.$transaction((tx) => tx.outbox.create({ data: wellFormed() }));
    await expect(
      store.client.$transaction((tx) => tx.outbox.create({ data: { ...wellFormed(), id: "other" } })),
    ).rejects.toThrow(/Outbox_idempotencyKey_key/);
  });

  test("a row naming a commitment that does not exist is rejected by the foreign key", async () => {
    const store = fixtures.storeFor(fixture);
    await expect(
      store.client.$transaction((tx) => tx.outbox.create({ data: wellFormed() })),
    ).rejects.toThrow(/Outbox_commitmentId_fkey/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.3 — ordering. RECALL is never applied before its OFFER.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("per-scope sequencing (§11.3, §10.5)", () => {
  const fixture = fixtures.seed();

  test("the namespace follows the fence scope, and a query has none", () => {
    expect(sequence.namespaceOf("OFFER").namespace).toBe("commitment");
    expect(sequence.namespaceOf("QUARANTINE").namespace).toBe("agent");
    expect(() => sequence.namespaceOf("PROBE")).toThrow(/never sequenced/);
  });

  test("mission and agent sequences are allocated independently", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });

    const allocated = await store.client.$transaction(async (tx) => {
      const m0 = await sequence.allocate(tx, { command: "OFFER", commitmentId: "commitment-c1" });
      await outbox.enqueue(tx, outbox.buildRow(missionRow({ sequence: m0 })));

      const a0 = await sequence.allocate(tx, { command: "QUARANTINE", agentId: fixture.agent.id });
      await outbox.enqueue(tx, outbox.buildRow(agentRow({ command: "QUARANTINE", sequence: a0 })));

      const m1 = await sequence.allocate(tx, { command: "RECALL", commitmentId: "commitment-c1" });
      const a1 = await sequence.allocate(tx, { command: "STAND_DOWN_ALL", agentId: fixture.agent.id });
      return { m0, a0, m1, a1 };
    });

    // Three agent commands would have pushed the mission counter to 3 under a single
    // shared sequence; keeping them separate is what makes each namespace's key
    // reproducible from its own record (§10.5).
    expect(allocated).toEqual({ m0: 0, a0: 0, m1: 1, a1: 1 });
  });

  test("the agent applies in order, ignores duplicates, and holds on a gap", () => {
    const { APPLY, DUPLICATE, HELD_FOR_ORDER } = sequence.ORDERING_DISPOSITION;
    expect(sequence.disposition({ sequence: 0 }, null).disposition).toBe(APPLY);
    expect(sequence.disposition({ sequence: 1 }, null).disposition).toBe(HELD_FOR_ORDER);
    expect(sequence.disposition({ sequence: 3 }, 2).disposition).toBe(APPLY);
    expect(sequence.disposition({ sequence: 2 }, 2).disposition).toBe(DUPLICATE);
    expect(sequence.disposition({ sequence: 1 }, 2).disposition).toBe(DUPLICATE);
    expect(sequence.disposition({ sequence: 5 }, 2).disposition).toBe(HELD_FOR_ORDER);
  });

  test("the ordering rule is what forbids RECALL before OFFER — asserted, not assumed", () => {
    const bad = sequence.checkApplicationOrder([
      { command: "RECALL", sequence: 1 },
      { command: "OFFER", sequence: 0 },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.violation.command).toBe("RECALL");

    const good = sequence.checkApplicationOrder([
      { command: "OFFER", sequence: 0 },
      { command: "RECALL", sequence: 1 },
    ]);
    expect(good.ok).toBe(true);
  });

  test("a gap makes the reordering unreachable: RECALL at sequence 1 is held while OFFER is missing", () => {
    // The agent has applied nothing. RECALL carries sequence 1, so the rule holds it
    // rather than applying it, and the OFFER at sequence 0 is still in the outbox
    // being retried. This is the mechanism behind the property above.
    expect(sequence.disposition({ command: "RECALL", sequence: 1 }, null).disposition).toBe(
      sequence.ORDERING_DISPOSITION.HELD_FOR_ORDER,
    );
  });

  test("every superseding mission command is covered by the ordering check", () => {
    const covered = new Set(sequence.SUPERSEDING_MISSION_COMMANDS);
    for (const command of fencing.MISSION_COMMANDS) {
      if (command === "OFFER") continue;
      expect({ command, covered: covered.has(command) }).toEqual({ command, covered: true });
    }
  });
});
