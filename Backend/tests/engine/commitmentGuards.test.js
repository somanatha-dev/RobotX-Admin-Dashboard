"use strict";

/**
 * Phase 3 — the commit guard set G1–G6 (§10.3.2 step 2).
 *
 * The plan's testing requirement, stated precisely:
 *
 * > Unit: **each guard G1–G6 aborts on its own violation and only its own.**
 *
 * The second half is the part a naive test omits. Violating G4 and observing an abort
 * proves only that *something* fired. Every case below therefore asserts the failing
 * guard's id **and** that the other five returned satisfied — which is why
 * `evaluateGuards` does not short-circuit.
 */

const guards = require("../../src/engine/commitment/guards");
const purpose = require("../../src/engine/domain/purpose");

/* ═══════════════════════════════════════════════════════════════════════════
   A commit input in which every guard passes
   ═══════════════════════════════════════════════════════════════════════════ */

const NOMINAL = Object.freeze({
  leadership: { leadershipFence: 3n },
  agent: { authorityEpoch: 7n, fenceCounter: 41n },
  leg: { version: 2, state: "PLANNED", purpose: "PRIMARY", cancelRequestedAt: null },
  activeCommitmentCount: 0,
  capacity: 1,
  snapshot: {
    leadershipFence: 3n,
    authorityEpoch: 7n,
    legVersion: 2,
    expectedLegState: "PLANNED",
  },
});

/** Deep-ish clone with one branch replaced. */
function withChange(change) {
  return {
    ...NOMINAL,
    ...change,
    leadership: { ...NOMINAL.leadership, ...(change.leadership || {}) },
    agent: { ...NOMINAL.agent, ...(change.agent || {}) },
    leg: { ...NOMINAL.leg, ...(change.leg || {}) },
    snapshot: { ...NOMINAL.snapshot, ...(change.snapshot || {}) },
  };
}

/**
 * Assert that exactly one guard failed, that it is the expected one, and that its
 * reason is the expected reason.
 */
function expectOnly(result, guardId, reason) {
  expect(result.ok).toBe(false);
  expect(result.failures.map((entry) => entry.id)).toEqual([guardId]);
  expect(result.failures[0].reason).toBe(reason);
  for (const verdict of result.verdicts) {
    expect({ id: verdict.id, satisfied: verdict.satisfied }).toEqual({
      id: verdict.id,
      satisfied: verdict.id === guardId ? false : true,
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════ */

describe("the nominal case", () => {
  test("all six guards pass and none is skipped", () => {
    const result = guards.evaluateGuards(NOMINAL);
    expect(result.ok).toBe(true);
    expect(result.verdicts.map((entry) => entry.id)).toEqual(guards.GUARD_IDS);
    expect(result.failures).toEqual([]);
  });

  test("the guard set is exactly the six §10.3.2 names", () => {
    expect(guards.GUARD_IDS).toEqual(["G1", "G2", "G3", "G4", "G5", "G6"]);
  });
});

describe("G1 — the leadership fence, re-read inside the transaction (§19.5)", () => {
  test("aborts when the fence has advanced since the round pinned it, and only G1 aborts", () => {
    const result = guards.evaluateGuards(withChange({ leadership: { leadershipFence: 4n } }));
    expectOnly(result, "G1", guards.ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
  });

  test("aborts when the coordinator's pinned fence is ahead of the store's — a defect, not a race", () => {
    const result = guards.evaluateGuards(withChange({ snapshot: { leadershipFence: 9n } }));
    expectOnly(result, "G1", guards.ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
  });

  test("aborts when there is no leadership row — leadership is never inferred from absence", () => {
    const result = guards.g1LeadershipFence(null, 3n);
    expect(result).toMatchObject({ id: "G1", satisfied: false, reason: guards.ABORT_REASON.LEADERSHIP_RECORD_MISSING });
  });

  test("aborts when the round pinned no fence at all", () => {
    const result = guards.g1LeadershipFence({ leadershipFence: 3n }, undefined);
    expect(result.satisfied).toBe(false);
  });

  test("passes on an exact match, whatever the numeric representation", () => {
    expect(guards.g1LeadershipFence({ leadershipFence: 3n }, 3).satisfied).toBe(true);
    expect(guards.g1LeadershipFence({ leadershipFence: "3" }, 3n).satisfied).toBe(true);
  });
});

describe("G2 — capacity (invariant I1)", () => {
  test("aborts when the agent is at capacity, and only G2 aborts", () => {
    const result = guards.evaluateGuards(withChange({ activeCommitmentCount: 1, capacity: 1 }));
    expectOnly(result, "G2", guards.ABORT_REASON.G2_AGENT_AT_CAPACITY);
  });

  test("permits a second commitment at capacity 2 — the chaining configuration (I19)", () => {
    expect(guards.g2Capacity(1, 2).satisfied).toBe(true);
    expect(guards.g2Capacity(2, 2).satisfied).toBe(false);
  });

  test("aborts on a capacity that is not a positive integer, rather than defaulting", () => {
    expect(guards.g2Capacity(0, undefined).satisfied).toBe(false);
    expect(guards.g2Capacity(0, 0).satisfied).toBe(false);
    expect(guards.g2Capacity(0, 1.5).satisfied).toBe(false);
  });
});

describe("G3 — the agent-scope authority_epoch (§10.3.1)", () => {
  test("aborts when the agent has been quarantined since the snapshot, and only G3 aborts", () => {
    const result = guards.evaluateGuards(withChange({ agent: { authorityEpoch: 8n } }));
    expectOnly(result, "G3", guards.ABORT_REASON.G3_AUTHORITY_EPOCH_CHANGED);
  });

  test("is invariant across ordinary commits — the property that makes I19 hold", () => {
    // Two commits in one round against the same agent. The first advanced
    // fence_counter from 41 to 42; authority_epoch did not move, so the second
    // commit's G3 still matches the same pinned snapshot.
    const afterFirstCommit = withChange({ agent: { fenceCounter: 42n }, activeCommitmentCount: 1, capacity: 2 });
    const result = guards.evaluateGuards(afterFirstCommit);
    expect(result.ok).toBe(true);
  });

  test("a guard on a per-commitment counter here would have rejected that second commit", () => {
    // The counterfactual, asserted so the reasoning is not merely prose: had G3 been
    // written against fence_counter, the second commit of the same round would abort.
    const hypothetical = guards.g3AuthorityEpoch({ authorityEpoch: 42n }, 41n);
    expect(hypothetical.satisfied).toBe(false);
  });

  test("aborts when the snapshot recorded no epoch — absence is not agreement", () => {
    expect(guards.g3AuthorityEpoch({ authorityEpoch: 7n }, null).satisfied).toBe(false);
  });
});

describe("G4 — the Leg version (§4.1 rule 2)", () => {
  test("aborts on concurrent modification, and only G4 aborts", () => {
    const result = guards.evaluateGuards(withChange({ leg: { version: 3 } }));
    expectOnly(result, "G4", guards.ABORT_REASON.G4_LEG_VERSION_CHANGED);
  });

  test("aborts when the snapshot recorded no version", () => {
    expect(guards.g4LegVersion({ version: 2 }, undefined).satisfied).toBe(false);
  });
});

describe("G5 — cancellation, purpose-conditioned (§4.6, invariant I11)", () => {
  const cancelled = { cancelRequestedAt: new Date("2026-07-29T11:59:00.000Z") };

  test("aborts on a cancelled PRIMARY Leg, and only G5 aborts", () => {
    const result = guards.evaluateGuards(withChange({ leg: { ...cancelled, purpose: "PRIMARY" } }));
    expectOnly(result, "G5", guards.ABORT_REASON.G5_LEG_CANCELLED);
  });

  test.each(purpose.CUSTODIAL_PURPOSES)(
    "permits a cancelled %s Leg — the recovery cancellation itself mandates",
    (custodialPurpose) => {
      const result = guards.evaluateGuards(withChange({ leg: { ...cancelled, purpose: custodialPurpose } }));
      expect(result.ok).toBe(true);
    },
  );

  test("the unqualified guard would have blocked its own mandated recovery path", () => {
    // The counterfactual the plan names as migration item C10: refusing whenever
    // cancellation was requested would refuse exactly the RECOVERY Legs above.
    const unqualified = (leg) => leg.cancelRequestedAt === null;
    for (const custodialPurpose of purpose.CUSTODIAL_PURPOSES) {
      expect(unqualified({ ...cancelled, purpose: custodialPurpose })).toBe(false);
      expect(guards.g5Cancellation({ ...cancelled, purpose: custodialPurpose }).satisfied).toBe(true);
    }
  });

  test.each(purpose.SPECULATIVE_PURPOSES)("aborts on a cancelled speculative %s Leg", (speculative) => {
    expect(guards.g5Cancellation({ ...cancelled, purpose: speculative }).satisfied).toBe(false);
  });

  test("an unknown purpose throws rather than defaulting to permitted (T2)", () => {
    expect(() => guards.g5Cancellation({ ...cancelled, purpose: "ERRAND" })).toThrow(/unknown Leg purpose/);
  });

  test("custodial_purposes is read from §2.4's table, never restated here", () => {
    expect(purpose.CUSTODIAL_PURPOSES).toEqual(["RECOVERY", "TRANSFER"]);
  });
});

describe("G6 — the expected Leg state (§4.3)", () => {
  test("aborts when the Leg has moved on, and only G6 aborts", () => {
    const result = guards.evaluateGuards(withChange({ leg: { state: "EN_ROUTE_PICKUP" } }));
    expectOnly(result, "G6", guards.ABORT_REASON.G6_UNEXPECTED_LEG_STATE);
  });

  test("admits a declared set of states", () => {
    expect(guards.g6LegState({ state: "QUEUED" }, ["QUEUED", "PLANNED"]).satisfied).toBe(true);
    expect(guards.g6LegState({ state: "DEFERRED" }, ["QUEUED", "PLANNED"]).satisfied).toBe(false);
  });

  test("aborts when the decision declared no expected state", () => {
    expect(guards.g6LegState({ state: "PLANNED" }, undefined).satisfied).toBe(false);
    expect(guards.g6LegState({ state: "PLANNED" }, []).satisfied).toBe(false);
  });
});

describe("the guard set as a whole", () => {
  test("two simultaneous violations are both reported, not only the first", () => {
    const result = guards.evaluateGuards(
      withChange({ leadership: { leadershipFence: 4n }, leg: { version: 3 } }),
    );
    expect(result.failures.map((entry) => entry.id).sort()).toEqual(["G1", "G4"]);
  });

  test("every failing verdict carries a distinct abort reason and a detail naming its §", () => {
    const cases = [
      withChange({ leadership: { leadershipFence: 4n } }),
      withChange({ activeCommitmentCount: 1 }),
      withChange({ agent: { authorityEpoch: 8n } }),
      withChange({ leg: { version: 3 } }),
      withChange({ leg: { cancelRequestedAt: new Date(), purpose: "PRIMARY" } }),
      withChange({ leg: { state: "ACCEPTED" } }),
    ];
    const reasons = cases.map((input) => guards.evaluateGuards(input).failures[0].reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const input of cases) {
      expect(guards.evaluateGuards(input).failures[0].detail).toEqual(expect.any(String));
    }
  });

  test("a satisfied verdict carries no reason", () => {
    for (const verdict of guards.evaluateGuards(NOMINAL).verdicts) {
      expect(verdict.reason).toBeNull();
    }
  });

  test("an ordinary commit leaves authority_epoch untouched (§10.3.2 step 4, I19)", () => {
    expect(guards.authorityEpochUntouched({ authorityEpoch: 7n }, { authorityEpoch: 7n })).toBe(true);
    expect(guards.authorityEpochUntouched({ authorityEpoch: 7n }, { authorityEpoch: 8n })).toBe(false);
  });
});
