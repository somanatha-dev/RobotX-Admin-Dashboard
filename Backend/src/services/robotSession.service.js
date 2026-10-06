"use strict";

/**
 * **C1 — the durable half of a robot's legacy session.**
 *
 * ── The defect (LAN-3) ─────────────────────────────────────────────────────
 * Pairing mints a bearer token, and the token lived only in the KV as `session:{robotId}`.
 * With `REDIS_ENABLED=false` that KV is process memory. A backend restart therefore erased
 * every session. A paired robot presenting its token then fell through to the pairing branch
 * with a code already consumed at its first pairing. Five of those and the robot was locked
 * out for an hour.
 *
 * ── What this module changes, and what it does not ─────────────────────────
 * AUTH's contract is unchanged. The Pi presents `{robotId, token}` and gets the same token
 * back in AUTH_SUCCESS. The KV entry is still written and still consulted first, exactly as
 * before. What is added is one `RobotSession` row per robot. It holds a SHA-256 of the token
 * and the same 24 h sliding expiry the KV key has. AUTH reads the row only when the KV has
 * **no** `session:` value at all.
 *
 * The row's lifetime is the KV key's:
 *   - pairing  → `recordIssued` replaces it (the previous token is revoked durably as well)
 *   - reconnect → the sliding expiry is pushed forward (`refresh` / `validate`)
 *   - mTLS binding replaces the bearer scheme → `revoke` removes it
 *   - Robot row deleted → the foreign key cascades
 *
 * ── Why only a hash ────────────────────────────────────────────────────────
 * The token is `crypto.randomUUID()`: 122 random bits. An unsalted SHA-256 of it cannot be
 * inverted by guessing, so a database read yields nothing that authenticates. Validation
 * hashes the presented token and matches on the hash.
 */

const crypto = require("crypto");

/** The session's sliding lifetime: the TTL the `session:` KV key has always carried. */
const SESSION_TTL_SEC = 86400;

/**
 * @param {string} token
 * @returns {string} lowercase hex SHA-256
 */
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function expiryFrom(now) {
  return new Date(now.getTime() + SESSION_TTL_SEC * 1000);
}

/**
 * A token was just issued at pairing. It replaces whatever this robot held, which is what
 * revokes the previous token durably and not only in the KV.
 *
 * Not best-effort: a session that cannot be recorded is not issued. The caller lets this
 * throw before the pairing code is consumed, so the robot can retry with the same code.
 *
 * @param {object} prisma
 * @param {string} robotDbId `Robot.id`
 * @param {string} token
 * @param {Date} [now]
 */
async function recordIssued(prisma, robotDbId, token, now = new Date()) {
  const data = { tokenHash: hashToken(token), expiresAt: expiryFrom(now) };
  await prisma.robotSession.upsert({ where: { robotDbId }, create: { robotDbId, ...data }, update: data });
}

/**
 * The KV accepted this token. Slide the durable expiry forward to match the KV key's
 * refreshed TTL.
 *
 * The update is conditional on the hash. A pairing that completed after the KV read is
 * therefore never overwritten with the older token. A robot with no row yet (for example,
 * a session established before this table existed, under Redis) gets one.
 *
 * @returns {Promise<"REFRESHED"|"CREATED"|"SUPERSEDED">}
 */
async function refresh(prisma, robotDbId, token, now = new Date()) {
  const tokenHash = hashToken(token);
  const expiresAt = expiryFrom(now);
  const updated = await prisma.robotSession.updateMany({ where: { robotDbId, tokenHash }, data: { expiresAt } });
  if (updated && updated.count === 1) return "REFRESHED";
  try {
    await prisma.robotSession.create({ data: { robotDbId, tokenHash, expiresAt } });
    return "CREATED";
  } catch (e) {
    // A row for another token already exists: a later pairing owns it. Leave it alone.
    if (e && e.code === "P2002") return "SUPERSEDED";
    throw e;
  }
}

/**
 * The KV holds no session for this robot (a restart, with the KV in process memory). Is the
 * presented token this robot's live session?
 *
 * One conditional update both answers and slides the expiry. It matches only this robot,
 * only the hash of this token, and only an expiry still in the future, so a concurrent
 * pairing or an expiry can never be raced into an admission.
 *
 * @returns {Promise<boolean>}
 */
async function validate(prisma, robotDbId, token, now = new Date()) {
  if (typeof token !== "string" || token.length === 0) return false;
  const result = await prisma.robotSession.updateMany({
    where: { robotDbId, tokenHash: hashToken(token), expiresAt: { gt: now } },
    data: { expiresAt: expiryFrom(now) },
  });
  return Boolean(result) && result.count === 1;
}

/**
 * R2 — the robot is still connected on the session it authenticated with. Slide the durable
 * expiry forward, so a session in continuous use does not lapse 24 h after its last AUTH.
 *
 * Called from the heartbeat's throttled database flush with the hash the socket recorded at
 * AUTH (the socket never holds the token itself). One conditional update: this robot, this
 * hash, an expiry still in the future. It therefore never creates a row, never brings back an
 * expired one, and never extends a token a later pairing has replaced. The KV `session:` key is
 * deliberately not touched: once it lapses, AUTH's durable path reads this row.
 *
 * @param {object} prisma
 * @param {string} robotDbId `Robot.id`
 * @param {string} tokenHash `hashToken(token)` of the socket's bearer token
 * @param {Date} [now]
 * @returns {Promise<boolean>} whether the live session was extended
 */
async function renewLive(prisma, robotDbId, tokenHash, now = new Date()) {
  if (typeof robotDbId !== "string" || robotDbId.length === 0) return false;
  if (typeof tokenHash !== "string" || tokenHash.length === 0) return false;
  const result = await prisma.robotSession.updateMany({
    where: { robotDbId, tokenHash, expiresAt: { gt: now } },
    data: { expiresAt: expiryFrom(now) },
  });
  return Boolean(result) && result.count === 1;
}

/**
 * The bearer scheme no longer applies to this robot (an mTLS binding replaced it).
 *
 * @param {object} prisma
 * @param {string} robotDbId
 */
async function revoke(prisma, robotDbId) {
  await prisma.robotSession.deleteMany({ where: { robotDbId } });
}

module.exports = { SESSION_TTL_SEC, hashToken, recordIssued, refresh, validate, renewLive, revoke };
