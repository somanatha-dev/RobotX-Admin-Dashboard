"use strict";

/**
 * **F14 — Command path proven: a recent command round-trip or heartbeat ACK
 * succeeded.** Class I. Indeterminate: `DENY`.
 *
 * > A socket that is open but not carrying traffic is not a proven command path; this
 * > is the predicate that prevents dispatching to a silently dead link.
 *
 * ── Why "open" is not "working" ─────────────────────────────────────────────
 * A TCP connection whose peer has gone away without a FIN stays open on this side
 * until a write fails or a keepalive expires — tens of seconds, sometimes minutes. In
 * that window `socket.connected` is `true` and every liveness check built on it
 * passes. The distinction this predicate draws is between *evidence the link exists*
 * and *evidence the link carried something*, and only the second is proof of a
 * command path.
 *
 * The proof is therefore an **acknowledged round trip**: something the server sent and
 * the agent answered. A frame the agent pushed unprompted is not proof — it
 * demonstrates agent→server reachability, which is the direction a command does not
 * travel. `f13` already establishes that inbound heartbeats are arriving; F14 exists
 * precisely because that is insufficient.
 *
 * ── Two admissible proofs, per §7.5 ─────────────────────────────────────────
 *   - a command round-trip that completed, or
 *   - a heartbeat **ACK** — the server-initiated half, acknowledged by the agent.
 *
 * Both are timestamps of a *completed* exchange, and the freshest governs. The budget
 * is `connectivity.max_heartbeat_age`, the same window F13 uses: a command path proven
 * only outside the liveness window is not proven now.
 *
 * On the volatile subset (§10.3.2 step 3).
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "an acknowledged server-initiated round trip within connectivity.max_heartbeat_age";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config, decisionTimeMs }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const config = context && context.config;
  const decisionTimeMs = context && context.decisionTimeMs;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  const maxAgeSeconds = tv.readParameter(config, "connectivity.max_heartbeat_age");
  if (!tv.isNumber(maxAgeSeconds)) {
    return tv.absent("connectivity.max_heartbeat_age", { required: REQUIRED, inputSource: "CONFIG" });
  }
  const maxAgeMs = tv.secondsToMs(maxAgeSeconds);

  if (!tv.isNumber(decisionTimeMs)) {
    return tv.indeterminate({
      required: REQUIRED,
      reason: "the round's pinned decision time is absent; round-trip age cannot be computed (T6, §9.6)",
    });
  }

  const session = agent.session;
  if (session === undefined || session === null) {
    return tv.absent("the agent's session state", { required: REQUIRED, inputSource: "SENSOR" });
  }

  const proofs = [
    { kind: "COMMAND_ROUND_TRIP", atMs: tv.epochMs(session.lastCommandRoundTripAt) },
    { kind: "HEARTBEAT_ACK", atMs: tv.epochMs(session.lastHeartbeatAckAt) },
  ].filter((proof) => proof.atMs !== null);

  if (proofs.length === 0) {
    return tv.indeterminate({
      observed: { proofs: [] },
      required: REQUIRED,
      inputSource: "SENSOR",
      reason:
        "neither a completed command round trip nor an acknowledged heartbeat is recorded. An open " +
        "socket carrying no acknowledged traffic is not a proven command path (§7.5 F14)",
    });
  }

  // The freshest proof governs; a stale one does not become fresher by being joined
  // by another stale one.
  const best = proofs.reduce((freshest, proof) => (proof.atMs > freshest.atMs ? proof : freshest));
  const ageMs = decisionTimeMs - best.atMs;

  if (ageMs < 0) {
    return tv.indeterminate({
      observed: { proof: best.kind, ageMs },
      required: { maxAgeMs },
      inputSource: "SENSOR",
      observationAgeMs: ageMs,
      reason: "the proving exchange is stamped after the pinned decision time (clock skew, §10.6)",
    });
  }

  if (ageMs > maxAgeMs) {
    return tv.violated({
      observed: { proof: best.kind, ageMs },
      required: { maxAgeMs },
      inputSource: "SENSOR",
      observationAgeMs: ageMs,
      margin: maxAgeMs - ageMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason:
        `the most recent acknowledged round trip (${best.kind}) is ${ageMs} ms old, beyond the ` +
        `${maxAgeMs} ms budget. A command path proven only outside the liveness window is not ` +
        "proven now (§7.5 F14)",
    });
  }

  return tv.satisfied({
    observed: { proof: best.kind, ageMs },
    required: { maxAgeMs },
    inputSource: "SENSOR",
    observationAgeMs: ageMs,
    margin: maxAgeMs - ageMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate };
