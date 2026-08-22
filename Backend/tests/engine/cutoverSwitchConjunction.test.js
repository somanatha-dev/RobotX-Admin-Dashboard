"use strict";

/**
 * Engine lane — the cutover switch is a conjunction, **everywhere**, including the agent
 * path. (D-6, Phase 15 remediation.)
 *
 * ── What this file used to be, and why it was replaced rather than edited ───
 * Until this remediation this suite *pinned a defect*. `cutover/enabled.js` was written
 * because the switch has two halves — `processEnabled()` and `configEnabled()` — and Phase
 * 15 converted exactly one call site (`services/task.service.js`, the intake path). Every
 * socket handler still read `process.env.ENGINE_ENABLED === "true"` with no shard in the
 * question, and three of those guarded engine **write** paths:
 *
 *   - `command.handler.js`  — settles an outbox row to ACKED
 *   - `offer.handler.js`    — releases a commitment, moves a Leg, renews a lease
 *   - `robot.handler.js`    — suppresses outbox rows, advances an agent's authority epoch
 *
 * A staged rollout *requires* a deployment-wide `ENGINE_ENABLED=true`, so those writes were
 * live for every shard — including the ones `cutover/stage.js` had deliberately not reached.
 * The old file's own header said its assertions "must be DELETED, not edited, when the
 * conversion lands", because every one of them was written to fail at exactly that moment.
 * They did. This is the replacement, and it asserts the property rather than the gap.
 *
 * ── The rule, stated once ──────────────────────────────────────────────────
 *
 *     ENGINE_ENABLED  ∧  session authenticated  ∧  shard identity known and fresh
 *                     ∧  a configuration is loaded  ∧  it enables *this* shard
 *
 * `engine/cutover/agentGate.js` is the one place that evaluates it. These tests attack it
 * from both directions: every missing input must refuse, and the single complete case must
 * allow — because a gate that refuses everything is not a gate, it is an outage.
 */

const fs = require("fs");
const path = require("path");

const enabled = require("../../src/engine/cutover/enabled");
const agentGate = require("../../src/engine/cutover/agentGate");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

/** The region the staging order has reached. */
const LIVE_REGION = "region-live";
/** A region the staging order has deliberately not reached yet. */
const DARK_REGION = "region-dark";

const NOW = 1_800_000_000_000;

/**
 * A published configuration snapshot that has staged exactly one region.
 *
 * Resolution is by `region` because §22.2's hierarchy has no shard level and
 * `cutover.engine_enabled` is region-scoped — the same convention `enabled.configEnabled()`
 * applies.
 */
function snapshot(stagedRegions) {
  const staged = new Set(stagedRegions || [LIVE_REGION]);
  return {
    resolve(name, context) {
      if (name !== enabled.PARAMETER) return undefined;
      return staged.has(context && context.region);
    },
  };
}

/** An authenticated socket carrying a resolved shard identity. */
function socketFor(identity, overrides) {
  return {
    data: {
      isAuthed: true,
      robotId: "agent-1",
      [agentGate.SOCKET_DATA_KEY]: identity,
      ...(overrides || {}),
    },
  };
}

/** A freshly-resolved identity for a shard in `regionId`. */
function identity(shardId, regionId, resolvedAtMs) {
  return {
    agentRowId: "row-1",
    agentId: "agent-1",
    shardId,
    regionId,
    authorityEpoch: "3",
    resolvedAtMs: resolvedAtMs === undefined ? NOW : resolvedAtMs,
  };
}

const ON = { ENGINE_ENABLED: "true" };
const OFF = { ENGINE_ENABLED: "false" };

/* ═══════════════════════════════════════════════════════════════════════════
   The four headline cases §8 names
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the staged rollout is enforced on the agent path", () => {
  test("enabled shard → allowed", () => {
    const verdict = agentGate.assess({
      socket: socketFor(identity("shard-a", LIVE_REGION)),
      snapshot: snapshot([LIVE_REGION]),
      env: ON,
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({ allowed: true, refusal: null, shardId: "shard-a", regionId: LIVE_REGION });
  });

  test("disabled shard → refused, while the process flag is true", () => {
    // The exact staged-rollout case: the deployment-wide flag is on because staging
    // requires it, and this shard has not been reached.
    const verdict = agentGate.assess({
      socket: socketFor(identity("shard-b", DARK_REGION)),
      snapshot: snapshot([LIVE_REGION]),
      env: ON,
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({ allowed: false, refusal: agentGate.REFUSAL.SHARD_NOT_ENABLED });
  });

  test("engine disabled → refused, even for a staged shard", () => {
    const verdict = agentGate.assess({
      socket: socketFor(identity("shard-a", LIVE_REGION)),
      snapshot: snapshot([LIVE_REGION]),
      env: OFF,
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({ allowed: false, refusal: agentGate.REFUSAL.PROCESS_NOT_ENABLED });
  });

  test("wrong shard → refused: the verdict follows the agent's shard, not the deployment's", () => {
    // Two shards, one staged. The same process, the same flag, the same snapshot: the only
    // difference is which shard owns the agent, which is the whole point of a staged cutover.
    const staged = snapshot([LIVE_REGION]);
    const live = agentGate.assess({ socket: socketFor(identity("shard-a", LIVE_REGION)), snapshot: staged, env: ON, nowMs: NOW });
    const dark = agentGate.assess({ socket: socketFor(identity("shard-b", DARK_REGION)), snapshot: staged, env: ON, nowMs: NOW });

    expect(live.allowed).toBe(true);
    expect(dark.allowed).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §9 — planted adversarial cases. Every one must refuse.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("PLANTED — every unauthorised path refuses", () => {
  const staged = snapshot([LIVE_REGION]);

  test("PLANTED: stale session — an unauthenticated socket names no agent and so no shard", () => {
    const socket = socketFor(identity("shard-a", LIVE_REGION), { isAuthed: false });
    expect(agentGate.assess({ socket, snapshot: staged, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SESSION_NOT_AUTHENTICATED,
    });
  });

  test("PLANTED: unknown robot — AUTH resolved no identity, so every engine path is refused", () => {
    // `resolveIdentity()` returns null for an agent with no row and for one with no live
    // `ShardMembership`. §3.5 makes membership explicit: an unplaced agent belongs to no
    // shard, which is a real state and deliberately not defaulted to the default shard.
    expect(agentGate.assess({ socket: socketFor(null), snapshot: staged, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SHARD_IDENTITY_UNRESOLVED,
    });
  });

  test("PLANTED: missing shard — an identity with no shardId is not an identity", () => {
    const socket = socketFor({ agentId: "agent-1", shardId: null, regionId: LIVE_REGION, resolvedAtMs: NOW });
    expect(agentGate.assess({ socket, snapshot: staged, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SHARD_IDENTITY_UNRESOLVED,
    });
  });

  test("PLANTED: shard with no region — resolved at global scope would answer a different question", () => {
    // `cutover.engine_enabled` is region-scoped. A shard row naming no region cannot have
    // the parameter resolved *for it*; falling back to the global binding would answer a
    // question about the whole deployment as though it were a question about this shard.
    for (const regionId of [null, undefined, ""]) {
      const socket = socketFor(identity("shard-c", regionId));
      const verdict = agentGate.assess({ socket, snapshot: staged, env: ON, nowMs: NOW });
      expect({ regionId, allowed: verdict.allowed, refusal: verdict.refusal }).toEqual({
        regionId,
        allowed: false,
        refusal: agentGate.REFUSAL.SHARD_REGION_UNRESOLVED,
      });
    }
  });

  test("PLANTED — THE FAIL-OPEN: a region-less shard against a GLOBAL `true` binding", () => {
    // Found by the §19 hostile pass, in this remediation's own fix.
    //
    // `enabled.configEnabled()` builds its resolution context as
    // `if (regionId) context.region = regionId`, so a null region yields an **empty
    // context** — and an empty context resolves `cutover.engine_enabled` at *global* scope.
    // A deployment holding a global `true` therefore enabled a region-less shard: the answer
    // to "is the whole deployment cut over" substituted for "is this shard cut over", which
    // is precisely what per-shard staging exists to prevent.
    //
    // `Shard.regionId` is NOT NULL, so the data should never produce this — but
    // `resolveIdentity()` sets `regionId: null` when the `Shard` read *throws*, which made a
    // transient store blip a fail-open on a Tier 0 path.
    const globallyEnabled = {
      resolve(name, context) {
        if (name !== enabled.PARAMETER) return undefined;
        if (context && context.region) return context.region === LIVE_REGION;
        return true; // the global binding
      },
    };

    // A properly-regioned shard still resolves against its own region, both ways.
    expect(
      agentGate.mayAct({ socket: socketFor(identity("shard-a", LIVE_REGION)), snapshot: globallyEnabled, env: ON, nowMs: NOW }),
    ).toBe(true);
    expect(
      agentGate.mayAct({ socket: socketFor(identity("shard-b", DARK_REGION)), snapshot: globallyEnabled, env: ON, nowMs: NOW }),
    ).toBe(false);

    // And the region-less one is refused rather than inheriting the deployment's answer.
    expect(
      agentGate.assess({ socket: socketFor(identity("shard-c", null)), snapshot: globallyEnabled, env: ON, nowMs: NOW }),
    ).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SHARD_REGION_UNRESOLVED,
    });
  });
  test("PLANTED: stale shard mapping — an identity older than the freshness bound is refused", () => {
    const socket = socketFor(identity("shard-a", LIVE_REGION, NOW - agentGate.DEFAULT_MAX_AGE_MS - 1));
    expect(agentGate.assess({ socket, snapshot: staged, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SHARD_IDENTITY_STALE,
    });
  });

  test("PLANTED: an identity with no resolution timestamp is stale, not fresh", () => {
    // The direction matters: an absent `resolvedAtMs` must not read as "resolved at the
    // epoch of the caller's choosing". `Number.isFinite` fails closed.
    const socket = socketFor({ ...identity("shard-a", LIVE_REGION), resolvedAtMs: undefined });
    expect(agentGate.assess({ socket, snapshot: staged, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SHARD_IDENTITY_STALE,
    });
  });

  test("PLANTED: robot moved between shards — the pre-migration binding does not authorise the new shard", () => {
    // The agent was in the staged shard and has been migrated into one that is not staged.
    // Until the session is invalidated and re-AUTHs, its cached identity names the old
    // shard; the freshness bound is what stops that binding outliving the migration.
    const beforeMigration = identity("shard-a", LIVE_REGION, NOW - agentGate.DEFAULT_MAX_AGE_MS - 1);
    expect(agentGate.assess({ socket: socketFor(beforeMigration), snapshot: staged, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SHARD_IDENTITY_STALE,
    });

    // And once it does re-resolve, it resolves into the shard it is actually in.
    const afterMigration = identity("shard-b", DARK_REGION, NOW);
    expect(agentGate.assess({ socket: socketFor(afterMigration), snapshot: staged, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SHARD_NOT_ENABLED,
    });
  });

  test("PLANTED: forged shard identity on a socket that never authenticated", () => {
    // The order of the checks is load-bearing: the session is asked about before the
    // identity is read, so writing a plausible identity onto an unauthenticated socket
    // cannot buy admission.
    const socket = { data: { isAuthed: false, [agentGate.SOCKET_DATA_KEY]: identity("shard-a", LIVE_REGION) } };
    expect(agentGate.assess({ socket, snapshot: staged, env: ON, nowMs: NOW }).refusal).toBe(
      agentGate.REFUSAL.SESSION_NOT_AUTHENTICATED,
    );
  });

  test("PLANTED: no configuration loaded — distinguished from 'this shard is not staged'", () => {
    const socket = socketFor(identity("shard-a", LIVE_REGION));
    expect(agentGate.assess({ socket, snapshot: null, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.CONFIGURATION_UNAVAILABLE,
    });
    // An object that is not a snapshot is the same finding, not a crash.
    expect(agentGate.assess({ socket, snapshot: {}, env: ON, nowMs: NOW }).refusal).toBe(
      agentGate.REFUSAL.CONFIGURATION_UNAVAILABLE,
    );
  });

  test("PLANTED: a snapshot whose resolve() throws refuses rather than admitting", () => {
    const hostile = { resolve() { throw new Error("register unavailable"); } };
    expect(agentGate.assess({ socket: socketFor(identity("shard-a", LIVE_REGION)), snapshot: hostile, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SHARD_NOT_ENABLED,
    });
  });

  test("PLANTED: a snapshot resolving a truthy non-true value does not enable a shard", () => {
    // `configEnabled` compares `=== true`. A register that answered "yes" as a string would
    // otherwise stage every shard that asked.
    const sloppy = { resolve: () => "true" };
    expect(agentGate.mayAct({ socket: socketFor(identity("shard-a", LIVE_REGION)), snapshot: sloppy, env: ON, nowMs: NOW })).toBe(false);
  });

  test("PLANTED: direct handler invocation with no socket at all", () => {
    expect(agentGate.assess({ socket: null, snapshot: staged, env: ON, nowMs: NOW })).toMatchObject({
      allowed: false,
      refusal: agentGate.REFUSAL.SESSION_NOT_AUTHENTICATED,
    });
    expect(agentGate.mayAct({})).toBe(false);
    expect(agentGate.mayAct()).toBe(false);
  });

  test("PLANTED: invalidate() drops the binding, so the next assessment refuses", () => {
    const socket = socketFor(identity("shard-a", LIVE_REGION));
    expect(agentGate.mayAct({ socket, snapshot: staged, env: ON, nowMs: NOW })).toBe(true);
    agentGate.invalidate(socket);
    expect(agentGate.assess({ socket, snapshot: staged, env: ON, nowMs: NOW }).refusal).toBe(
      agentGate.REFUSAL.SHARD_IDENTITY_UNRESOLVED,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The conversion itself — no call site reassembles the conjunction
   ═══════════════════════════════════════════════════════════════════════════ */

/** Every agent-facing site that decides whether the engine may act. */
const CONVERTED_AGENT_PATHS = Object.freeze([
  { file: "src/sockets/handlers/command.handler.js", gates: "settles an outbox row to ACKED" },
  { file: "src/sockets/handlers/offer.handler.js", gates: "releases a commitment, moves a Leg, renews a lease" },
  { file: "src/sockets/handlers/robot.handler.js", gates: "suppresses outbox rows and advances an authority epoch" },
  { file: "src/sockets/handlers/telemetry.handler.js", gates: "predicate enforcement and health application" },
  { file: "src/sockets/handlers/dtaro.handler.js", gates: "the completion-claim path" },
]);

/** The intake path, converted at Phase 15 and still the reference. */
const CONVERTED_INTAKE = Object.freeze(["src/services/task.service.js"]);

function read(relative) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
}

/** Raw reads of the environment variable, excluding comment lines. */
function rawReads(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .filter((line) => /process\.env\.ENGINE_ENABLED/.test(line));
}

describe("every engine decision reads the switch through the module that owns it", () => {
  test("the intake path still reads both halves", () => {
    for (const file of CONVERTED_INTAKE) {
      const source = read(file);
      expect({ file, usesForShard: /forShard\s*\(/.test(source) }).toEqual({ file, usesForShard: true });
      expect({ file, rawReads: rawReads(source).length }).toEqual({ file, rawReads: 0 });
    }
  });

  test("REGRESSION — every agent path now asks the gate, and none reads the raw flag", () => {
    // This is the assertion the old suite was written to fail. Each of these five files
    // previously contained a bare `process.env.ENGINE_ENABLED` comparison and no shard.
    for (const entry of CONVERTED_AGENT_PATHS) {
      const source = read(entry.file);
      expect({ file: entry.file, rawReads: rawReads(source).length }).toEqual({ file: entry.file, rawReads: 0 });
      expect({ file: entry.file, usesGate: /agentGate\.(assess|mayAct)\s*\(/.test(source) }).toEqual({
        file: entry.file,
        usesGate: true,
      });
    }
  });

  test("REGRESSION — the three write paths are gated, named individually", () => {
    // The severity claim of the original finding, now asserted as the fix.
    const writers = [
      "src/sockets/handlers/command.handler.js",
      "src/sockets/handlers/offer.handler.js",
      "src/sockets/handlers/robot.handler.js",
    ];
    for (const file of writers) {
      expect({ file, gated: /agentGate\.(assess|mayAct)\s*\(/.test(read(file)) }).toEqual({ file, gated: true });
    }
  });

  test("the shard identity is bound at AUTH and refreshed on the heartbeat, not looked up per event", () => {
    const source = read("src/sockets/handlers/robot.handler.js");
    // Bound once, where the session is established.
    expect(source).toMatch(/socket\.data\.isAuthed = true;[\s\S]{0,2000}agentGate\.bind\(socket, await agentGate\.resolveIdentity\(/);
    // And refreshed on the heartbeat's existing throttled pass rather than on a new cadence.
    expect(source).toMatch(/prisma\.robot\.update\([\s\S]{0,2000}agentGate\.bind\(socket, await agentGate\.resolveIdentity\(/);
  });

  test("EXHAUSTIVENESS — a new raw read anywhere is a new finding", () => {
    // The one surviving raw read is the Config Service's own bootstrap decision, which is a
    // genuinely process-level question ("must this process load a pinned version") asked
    // before any shard identity exists to ask a per-shard one about.
    const known = new Set(["src/engine/config/service.js"]);
    const found = [];

    const walk = (directory) => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.name === "node_modules" || item.name === ".git") continue;
        const full = path.join(directory, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.name.endsWith(".js")) {
          const relative = path.relative(BACKEND_ROOT, full).split(path.sep).join("/");
          if (relative === "src/engine/cutover/enabled.js") continue;
          if (rawReads(fs.readFileSync(full, "utf8")).length > 0) found.push(relative);
        }
      }
    };
    walk(path.join(BACKEND_ROOT, "src"));
    if (rawReads(read("server.js")).length > 0) found.push("server.js");

    expect(found.filter((file) => !known.has(file))).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The module that owns the switch still offers both halves
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the two halves remain separable", () => {
  test("processEnabled is the process half and forShard is the conjunction", () => {
    expect(enabled.processEnabled({ ENGINE_ENABLED: "true" })).toBe(true);
    expect(enabled.processEnabled({ ENGINE_ENABLED: "false" })).toBe(false);

    expect(
      enabled.forShard({ snapshot: null, shard: { shardId: "s1", regionId: "r1" }, env: { ENGINE_ENABLED: "true" } }),
    ).toBe(false);
  });

  test("a caller that cannot name a shard gets false", () => {
    expect(enabled.forShard({ snapshot: null, shard: {}, env: { ENGINE_ENABLED: "true" } })).toBe(false);
  });
});
