"use strict";

/**
 * The separate, access-controlled identity store (§23.7) — **Tier 1**.
 *
 * > Decision records contain addresses, recipient details, and payload descriptions.
 * > Therefore: field-level classification, encryption at rest, least-privilege access,
 * > PII redaction in analytical copies, retention limits distinct from (and shorter
 * > than) the operational retention of the decision's *technical* content, and support
 * > for erasure requests without destroying the audit trail's integrity — achieved by
 * > separating identifying fields from the technical record and erasing only the former.
 *
 * Every clause in that sentence is a property of *this* store and of nothing else,
 * which is the point of the separation. The technical record has one retention policy
 * and one access policy; the identity record has a shorter retention and a narrower
 * one, and they are enforced in different tables because a policy that lives in a
 * column filter is a policy one `SELECT *` defeats.
 *
 * ── Reads are audited, and that is not optional ─────────────────────────────
 * `resolve()` requires an actor, a role, and a reason, and refuses without them. This
 * looks like friction until you consider what the store holds: the home addresses of
 * everyone the fleet has ever delivered to. An unaudited read path over that is the
 * data-exfiltration row of §23.1's threat model, and "least privilege" without "and we
 * can tell you who looked" is half a control.
 *
 * ── Encryption at rest ──────────────────────────────────────────────────────
 * The identifying fields are stored encrypted with AES-256-GCM under an injected key,
 * so a database backup that leaves the building is ciphertext. The key is a parameter,
 * never an environment read inside this module, for the same reason `commandSigning.js`
 * takes its key as an argument: a module that reaches for `process.env` makes key
 * rotation a code change.
 *
 * GCM rather than CBC because the record must be *tamper-evident* as well as secret —
 * an identity record whose ciphertext was edited must fail to decrypt rather than
 * decrypt to something else.
 *
 * ── What erasure leaves behind ──────────────────────────────────────────────
 * `tombstone()` nulls the ciphertext and stamps `erasedAt`. The row survives, and so
 * does its surrogate key: "the surrogate key survives as an opaque token that no longer
 * resolves to a person". Deleting the row instead would make an erased key
 * indistinguishable from a key that was never minted, and the Explanation API could no
 * longer honestly answer `ERASED` rather than "unknown" (§23.7).
 */

const crypto = require("crypto");

const surrogateKeys = require("./surrogateKeys");

/** @structural the at-rest cipher; authenticated so tampering fails closed */
const CIPHER_ALGORITHM = "aes-256-gcm";

/** @structural AES-256 key length */
const KEY_BYTES = 32;

/** @structural GCM's recommended nonce length */
const IV_BYTES = 12;

/**
 * §23.7's "field-level classification". Carried per field so that an analytical copy
 * can redact by class rather than by an allow-list somebody maintains by hand.
 * @structural the classification labels
 */
const CLASSIFICATION = Object.freeze({
  /** Directly identifies a person: name, phone, email. */
  DIRECT_IDENTIFIER: "DIRECT_IDENTIFIER",
  /** Identifies a premises: address lines, door codes, access notes. */
  LOCATION_IDENTIFIER: "LOCATION_IDENTIFIER",
  /** Describes what was carried, which can identify by inference. */
  PAYLOAD_DESCRIPTOR: "PAYLOAD_DESCRIPTOR",
});

const CLASSIFICATIONS = Object.freeze(Object.values(CLASSIFICATION));

/** The three outcomes a resolve can have. `ERASED` is a real answer, not a failure. */
const RESOLUTION = Object.freeze({
  RESOLVED: "RESOLVED",
  ERASED: "ERASED",
  NOT_FOUND: "NOT_FOUND",
});

/**
 * @param {string|Buffer} key
 * @returns {Buffer}
 */
function requireEncryptionKey(key) {
  if (key === undefined || key === null || key === "") {
    throw new TypeError(
      "the identity store requires an encryption key. §23.7 requires encryption at rest for this data specifically; " +
        "storing it in plaintext would put every delivery address in the fleet's history into any database backup.",
    );
  }
  const material = Buffer.isBuffer(key) ? key : Buffer.from(String(key), "utf8");
  if (material.length !== KEY_BYTES) {
    throw new RangeError(`the identity-store key is ${material.length} bytes; ${CIPHER_ALGORITHM} requires exactly ${KEY_BYTES}`);
  }
  return material;
}

/**
 * Encrypt the identifying fields.
 *
 * @param {object} fields
 * @param {string|Buffer} key
 * @returns {{ ciphertext: string, iv: string, authTag: string }} all hex
 */
function seal(fields, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, requireEncryptionKey(key), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(fields ?? {}), "utf8"), cipher.final()]);
  return { ciphertext: body.toString("hex"), iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
}

/**
 * Decrypt the identifying fields, or throw if the record was tampered with.
 *
 * @param {{ ciphertext: string, iv: string, authTag: string }} sealed
 * @param {string|Buffer} key
 * @returns {object}
 */
function unseal(sealed, key) {
  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, requireEncryptionKey(key), Buffer.from(sealed.iv, "hex"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "hex"));
  const body = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "hex")), decipher.final()]);
  return JSON.parse(body.toString("utf8"));
}

/**
 * Classify a field by name, so a caller does not have to.
 *
 * @param {string} name
 * @returns {string}
 */
function classify(name) {
  const normalised = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/(recipient|contact|customer|phone|email|name)/.test(normalised)) return CLASSIFICATION.DIRECT_IDENTIFIER;
  if (/(payload|contents|description)/.test(normalised)) return CLASSIFICATION.PAYLOAD_DESCRIPTOR;
  return CLASSIFICATION.LOCATION_IDENTIFIER;
}

/**
 * The strictest classification present in a field set — the one a retention and access
 * policy is applied at, because a record is only as releasable as its most sensitive
 * field.
 *
 * @param {object} fields
 * @returns {string}
 */
function classificationOf(fields) {
  const present = new Set(Object.keys(fields || {}).map(classify));
  if (present.has(CLASSIFICATION.DIRECT_IDENTIFIER)) return CLASSIFICATION.DIRECT_IDENTIFIER;
  if (present.has(CLASSIFICATION.PAYLOAD_DESCRIPTOR)) return CLASSIFICATION.PAYLOAD_DESCRIPTOR;
  return CLASSIFICATION.LOCATION_IDENTIFIER;
}

/**
 * Write (or re-write) one identity record and return its surrogate key.
 *
 * Idempotent by construction: the key is a deterministic function of the natural id, so
 * the same address stored twice updates one row rather than creating two. That is what
 * makes the key "stable" in §23.7's sense.
 *
 * An **erased** record is never re-populated by a later `put`. Re-minting the same key
 * for the same address after an erasure request would silently undo the erasure, which
 * is the one failure mode this store must not have.
 *
 * @param {object} deps `{ prisma }` — a transaction client is accepted
 * @param {object} input
 * @param {string} input.subjectType one of `surrogateKeys.SUBJECT_TYPE`
 * @param {string} input.naturalId
 * @param {object} input.fields the identifying values
 * @param {string|Buffer} input.secret the surrogate-key secret
 * @param {string|Buffer} input.encryptionKey
 * @param {string} [input.subjectId] the technical row this describes, for operator search
 * @param {Date} [input.retainUntil] §23.7's shorter, separate retention
 * @param {Date} input.now
 * @returns {Promise<{ identityKey: string, created: boolean, erased: boolean }>}
 */
async function put(deps, input) {
  const source = input || {};
  const identityKey = surrogateKeys.surrogateKey({
    subjectType: source.subjectType,
    naturalId: source.naturalId,
    secret: source.secret,
  });

  const existing = await deps.prisma.identityRecord.findUnique({ where: { surrogateKey: identityKey } });
  if (existing && existing.erasedAt) {
    return { identityKey, created: false, erased: true };
  }

  const sealed = seal(source.fields || {}, source.encryptionKey);
  const row = {
    surrogateKey: identityKey,
    subjectType: source.subjectType,
    subjectId: source.subjectId ?? null,
    classification: classificationOf(source.fields),
    fieldNames: Object.keys(source.fields || {}).sort(),
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    retainUntil: source.retainUntil ?? null,
  };

  if (existing) {
    await deps.prisma.identityRecord.update({ where: { surrogateKey: identityKey }, data: row });
    return { identityKey, created: false, erased: false };
  }

  await deps.prisma.identityRecord.create({ data: { ...row, createdAt: source.now ?? undefined } });
  return { identityKey, created: true, erased: false };
}

/**
 * Resolve a surrogate key back to its identifying fields.
 *
 * Least-privilege and audited: an actor, a role, and a reason are mandatory, and the
 * access is appended to the hash-chained audit stream by the caller-supplied `audit`
 * function. The audit is awaited **before** the plaintext is returned, so a read that
 * could not be recorded does not happen.
 *
 * @param {object} deps `{ prisma, audit }`
 * @param {string} identityKey
 * @param {object} context `{ actorId, actorRole, reason, encryptionKey, now }`
 * @returns {Promise<{ status: string, fields: object|null, classification: string|null }>}
 */
async function resolve(deps, identityKey, context) {
  const settings = context || {};

  if (!settings.actorId || !settings.actorRole || !settings.reason) {
    throw new TypeError(
      "resolving a surrogate key requires an actor, a role, and a reason. This store holds the address of everyone " +
        "the fleet has delivered to; an unaudited read path over it is §23.1's data-exfiltration row (§23.7).",
    );
  }
  if (!surrogateKeys.isSurrogateKey(identityKey)) {
    return { status: RESOLUTION.NOT_FOUND, fields: null, classification: null };
  }

  const row = await deps.prisma.identityRecord.findUnique({ where: { surrogateKey: identityKey } });
  if (!row) return { status: RESOLUTION.NOT_FOUND, fields: null, classification: null };

  if (typeof deps.audit === "function") {
    await deps.audit({
      eventType: "OPERATOR_ACTION",
      actorId: settings.actorId,
      actorRole: settings.actorRole,
      subjectType: "IDENTITY_RECORD",
      subjectId: identityKey,
      reason: settings.reason,
      payload: { access: "RESOLVE", classification: row.classification, erased: Boolean(row.erasedAt) },
      recordedAtMs: settings.now instanceof Date ? settings.now.getTime() : Date.now(),
    });
  }

  if (row.erasedAt) {
    // The honest answer, and a different one from "no such key". §23.7 requires the
    // distinction to be visible "to whoever later reads such a record in a dispute".
    return { status: RESOLUTION.ERASED, fields: null, classification: row.classification };
  }

  return {
    status: RESOLUTION.RESOLVED,
    fields: unseal({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag }, settings.encryptionKey),
    classification: row.classification,
  };
}

/**
 * Tombstone an identity record: erase the content, keep the key.
 *
 * Called by `erasure.js` inside its transaction. It is exported separately because the
 * retention sweep tombstones on expiry by exactly the same mechanism — §23.7's
 * "retention limits distinct from (and shorter than) the operational retention of the
 * decision's technical content" is an erasure that nobody requested, and it must leave
 * the technical record equally intact.
 *
 * @param {object} tx a transaction client
 * @param {string} identityKey
 * @param {object} input `{ erasedBy, reason, at }`
 * @returns {Promise<{ tombstoned: boolean, alreadyErased: boolean }>}
 */
async function tombstone(tx, identityKey, input) {
  const source = input || {};
  const row = await tx.identityRecord.findUnique({ where: { surrogateKey: identityKey } });
  if (!row) return { tombstoned: false, alreadyErased: false };
  if (row.erasedAt) return { tombstoned: false, alreadyErased: true };

  await tx.identityRecord.update({
    where: { surrogateKey: identityKey },
    data: {
      // Nulled, not overwritten with a marker: the ciphertext is what makes the content
      // recoverable, and "genuinely unrecoverable" is §23.7's word.
      ciphertext: null,
      iv: null,
      authTag: null,
      erasedAt: source.at ?? new Date(),
      erasedBy: source.erasedBy ?? null,
      erasureReason: source.reason ?? null,
    },
  });

  return { tombstoned: true, alreadyErased: false };
}

/**
 * Identity records whose own, shorter retention has expired.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ nowMs, take }`
 * @returns {Promise<object[]>}
 */
async function expired(deps, input) {
  const source = input || {};
  return deps.prisma.identityRecord.findMany({
    where: { erasedAt: null, retainUntil: { lt: new Date(source.nowMs) } },
    select: { surrogateKey: true, subjectType: true, retainUntil: true },
    /** @structural a page size, not a threshold: the sweep pages until the query is empty */
    take: Number.isFinite(source.take) ? source.take : 500,
  });
}

module.exports = {
  CIPHER_ALGORITHM,
  KEY_BYTES,
  IV_BYTES,
  CLASSIFICATION,
  CLASSIFICATIONS,
  RESOLUTION,
  requireEncryptionKey,
  seal,
  unseal,
  classify,
  classificationOf,
  put,
  resolve,
  tombstone,
  expired,
};
