"use strict";

/**
 * Surrogate keys and the identifying/derived separation (§23.7) — **Tier 1**.
 *
 * ── The tension this module resolves, and why it is resolved here ───────────
 * §23.7 states the problem in its own words:
 *
 * > Privacy requires erasing personally identifying data on request. Determinism (T6,
 * > invariant I10) requires that a stored decision replay bit-for-bit, and replay
 * > consumes the pinned input snapshot (§21.2) — which contains addresses. Erasing a
 * > field a decision record depends on breaks that decision's replayability.
 *
 * > The resolution is a schema rule, and it is binding on the decision-record and
 * > snapshot schemas: **No decision record or input snapshot stores an identifying
 * > value directly.** Both store a **stable surrogate key** into a separate,
 * > access-controlled identity store, plus the *derived, non-identifying* quantities
 * > the decision actually consumed.
 *
 * "Stating the separation as a principle is not enough to implement it" is the
 * section's own sentence, so this module makes the separation *checkable*: the
 * identifying field names are a register, `scan()` walks any record against it, and
 * `assertNonIdentifying()` refuses. A rule that only a reviewer enforces is a rule that
 * survives exactly as long as reviewers keep noticing.
 *
 * ── Why the key is an HMAC and not a UUID ───────────────────────────────────
 * §23.7 requires the key be **stable**: the same address must yield the same key
 * across rounds, or the same destination looks like two destinations to every
 * aggregation, and the identity store accumulates a row per decision. A random UUID is
 * stable only if something remembers the mapping *before* the key is minted, which is a
 * read-modify-write on the request path.
 *
 * A keyed digest is stable by construction and — because the key is secret — not
 * reversible by dictionary attack, which an unkeyed `sha256(address)` emphatically is:
 * the space of real addresses is small enough to enumerate. That distinction is the
 * whole security value of the construction, so `requireSecret()` refuses to run without
 * one rather than falling back to an unkeyed digest.
 *
 * ── What "derived, non-identifying" means, exactly ──────────────────────────
 * §23.7 enumerates them, and this module carries that enumeration rather than a
 * paraphrase: the fine cell, the zone, the geofence result, the access-window class,
 * the service-time cohort, and the coordinates quantised to the routing graph's node.
 * **The engine's arithmetic uses only these; a street address is never an input to a
 * cost term.** `tools/gates/checkIdentityIsolation.js` is the build gate that proves
 * the second half of that sentence.
 *
 * Nothing here performs I/O or reads a clock. `identityStore.js` owns the store;
 * `erasure.js` owns the tombstone.
 */

const crypto = require("crypto");

/** @structural the surrogate-key digest algorithm */
const DIGEST_ALGORITHM = "sha256";

/**
 * How many hex characters of the digest a surrogate key carries. 32 hex characters is
 * 128 bits, which is collision-free at any fleet size this system will ever see and
 * short enough that a key is readable in a log line during an incident.
 * @structural the surrogate key's length
 */
const KEY_HEX_LENGTH = 32;

/** @structural the surrogate key's prefix, so one is recognisable on sight */
const KEY_PREFIX = "sk";

/**
 * The subject types an identity record may describe. Enumerated because a surrogate
 * key names *what kind of thing* it stands for — a resolver handed a key with no type
 * cannot apply the right access policy, and "apply the strictest" is not a policy
 * anybody audits.
 * @structural the identity store's subject types
 */
const SUBJECT_TYPE = Object.freeze({
  /** §23.7 — "addresses, recipient details" belonging to a Task. */
  TASK: "TASK",
  /** One Stop's address, access instructions, and contact. */
  STOP: "STOP",
  /** §23.7 — "payload descriptions". */
  PAYLOAD: "PAYLOAD",
});

const SUBJECT_TYPES = Object.freeze(Object.values(SUBJECT_TYPE));

/**
 * The marker a resolved-but-erased identity renders as.
 *
 * > A replayed decision on an erased Task can no longer render a human-readable
 * > destination; the Explanation API returns the technical answer with the identifying
 * > fields marked `ERASED`. This is the correct trade and it is bounded, but it must be
 * > visible to whoever later reads such a record in a dispute.
 *
 * A distinguishable marker rather than `null`, because "we erased this" and "this was
 * never recorded" are different facts and a dispute turns on which one it was.
 * @structural the erasure marker, part of the Explanation API's contract
 */
const ERASED = "ERASED";

/**
 * §23.7's identifying fields, as a register.
 *
 * Every name here is a field whose *value* identifies a person or a premises. The list
 * is matched case-insensitively against a record's key path, so `pickupAddress`,
 * `pickup_address` and `stop.address` are all caught by `address`.
 *
 * Two names deserve their reasons stated, because both look technical:
 *
 *   - `lat` / `lon`. Raw coordinates *are* an address; §23.7 admits only "the
 *     coordinates quantised to the routing graph's node" into the decision path. A
 *     decision record holding six decimal places of latitude holds a doorstep.
 *   - `label`. `Stop.label` is where a human-readable address lands today. Its name
 *     does not advertise that, which is exactly why a register beats intuition.
 *
 * @structural §23.7's classification of identifying fields
 */
const IDENTIFYING_FIELDS = Object.freeze([
  "address",
  "addressline",
  "postcode",
  "postalcode",
  "zipcode",
  "label",
  "recipient",
  "recipientname",
  "recipientphone",
  "recipientemail",
  "contactname",
  "contactphone",
  "contactemail",
  "phone",
  "email",
  "customername",
  "buildingname",
  "unitnumber",
  "doorcode",
  "accessnote",
  "accessnotes",
  "deliveryinstructions",
  "payloaddescription",
  "contents",
  "lat",
  "lon",
  "latitude",
  "longitude",
  "pickup",
  "drop",
]);

const IDENTIFYING_FIELD_SET = new Set(IDENTIFYING_FIELDS);

/**
 * §23.7's enumerated *derived, non-identifying* quantities — "the fine cell, the zone,
 * the geofence result, the access-window class, the service-time cohort, the
 * coordinates quantised to the routing graph's node".
 *
 * These are the only spatial facts the decision path may consume about a Stop. The
 * list is carried as data so `derive()` cannot quietly grow a seventh field that
 * happens to be an address in a different shape.
 * @structural §23.7's own enumeration
 */
const DERIVED_QUANTITIES = Object.freeze([
  "fineCell",
  "zoneId",
  "geofenceResult",
  "accessWindowClass",
  "serviceTimeCohort",
  "routingNodeId",
]);

/**
 * Names that are **not** identifying despite matching the register by substring.
 *
 * Two kinds, and both are enumerated rather than pattern-matched, because a pattern that
 * excused a class of names would eventually excuse a real one:
 *
 *   - The mechanism's own vocabulary. `identityKey` and `surrogateKeys` are the columns
 *     that *fix* the problem; without this exemption the scan would flag them.
 *   - `shadowLabel` (§21.6). It ends in "label" and holds a shadow run's name — `baseline`,
 *     `candidate-v3` — never an address. It is listed here rather than removed from the
 *     suffix rule because `pickupLabel` and `dropLabel` must keep matching, and the cost
 *     of enumerating one collision is much lower than the cost of loosening the rule.
 */
const EXEMPT_FIELDS = Object.freeze(
  new Set(["identitykey", "surrogatekey", "surrogatekeys", "shadowlabel", ...DERIVED_QUANTITIES.map((name) => name.toLowerCase())]),
);

/**
 * Reject a secret that cannot carry the property the construction claims.
 *
 * An unkeyed digest over an address is reversible by enumeration — there are not many
 * addresses — so falling back to one would produce a token that *looks* opaque and is
 * not. Refusing is the only safe default.
 *
 * @param {string|Buffer} secret
 * @returns {Buffer}
 */
function requireSecret(secret) {
  if (secret === undefined || secret === null || secret === "") {
    throw new TypeError(
      "a surrogate key requires a secret. An unkeyed digest over an address is reversible by enumeration — the " +
        "space of real addresses is small — so the token would look opaque and not be (§23.7).",
    );
  }
  const material = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), "utf8");
  /** @structural the shortest secret admitted; below 128 bits the keyed digest is enumerable */
  const MINIMUM_SECRET_BYTES = 16;
  if (material.length < MINIMUM_SECRET_BYTES) {
    throw new RangeError(
      `the surrogate-key secret is ${material.length} bytes; below ${MINIMUM_SECRET_BYTES} it does not resist enumeration (§23.7)`,
    );
  }
  return material;
}

/**
 * Normalise a natural identifier before it is digested, so that two spellings of the
 * same address produce the same key.
 *
 * Deliberately conservative: case folding and whitespace collapse only. Anything
 * cleverer — punctuation stripping, abbreviation expansion — would merge two genuinely
 * different premises under one key, and a *false* identity merge is worse than a
 * duplicate: it would let one erasure request tombstone somebody else's record.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normaliseNaturalId(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Mint the stable surrogate key for a subject.
 *
 * @param {object} input
 * @param {string} input.subjectType one of `SUBJECT_TYPE`
 * @param {string} input.naturalId the identifying value this key stands for
 * @param {string|Buffer} input.secret
 * @returns {string} `sk_<type>_<128 bits of hex>`
 */
function surrogateKey(input) {
  const source = input || {};
  if (!SUBJECT_TYPES.includes(source.subjectType)) {
    throw new TypeError(
      `"${String(source.subjectType)}" is not one of ${SUBJECT_TYPES.join(", ")}. A surrogate key names what kind ` +
        "of thing it stands for, because a resolver handed an untyped key cannot apply the right access policy (§23.7).",
    );
  }
  const natural = normaliseNaturalId(source.naturalId);
  if (natural === "") {
    throw new TypeError("a surrogate key stands for a value; an empty natural id would make every empty subject the same subject");
  }

  const digest = crypto
    .createHmac(DIGEST_ALGORITHM, requireSecret(source.secret))
    // The subject type enters the digest, so the same string as a Task and as a Stop
    // are different keys. Without it, erasing a Task would tombstone a Stop.
    .update(`${source.subjectType}${natural}`, "utf8")
    .digest("hex")
    .slice(0, KEY_HEX_LENGTH);

  return `${KEY_PREFIX}_${source.subjectType.toLowerCase()}_${digest}`;
}

/**
 * Is this string shaped like a surrogate key?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSurrogateKey(value) {
  if (typeof value !== "string") return false;
  return new RegExp(`^${KEY_PREFIX}_(${SUBJECT_TYPES.map((type) => type.toLowerCase()).join("|")})_[0-9a-f]{${KEY_HEX_LENGTH}}$`).test(value);
}

/**
 * The subject type a surrogate key declares.
 *
 * @param {string} key
 * @returns {string|null}
 */
function subjectTypeOf(key) {
  if (!isSurrogateKey(key)) return null;
  return key.split("_")[1].toUpperCase();
}

/**
 * Is this field name an identifying one?
 *
 * Matched on the *normalised* name — lower-cased, with separators removed — and by
 * suffix as well as by equality, so `pickupAddress` and `pickup_address` both resolve to
 * `address`. Suffix matching is what stops a field being smuggled past the register by
 * prefixing it.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isIdentifyingField(name) {
  const normalised = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalised === "") return false;
  if (EXEMPT_FIELDS.has(normalised)) return false;
  if (IDENTIFYING_FIELD_SET.has(normalised)) return true;
  for (const identifying of IDENTIFYING_FIELD_SET) {
    // A three-character name like `lat` would match inside `translation`; requiring the
    // remainder to end at a word boundary in the original spelling is not available
    // after normalisation, so short names are matched only on equality.
    /** @structural the shortest register name that may be matched as a suffix */
    const SUFFIX_MATCHABLE_LENGTH = 5;
    if (identifying.length >= SUFFIX_MATCHABLE_LENGTH && normalised.endsWith(identifying)) return true;
  }
  return false;
}

/**
 * Walk a record and report every identifying field it holds.
 *
 * @param {*} value
 * @param {string} [path]
 * @returns {Array<{ path: string, field: string }>} in encounter order
 */
function scan(value, path) {
  const found = [];
  const walk = (node, at) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${at}[${index}]`));
      return;
    }
    if (typeof node !== "object") return;
    if (node instanceof Date) return;

    for (const [key, inner] of Object.entries(node)) {
      const childPath = at ? `${at}.${key}` : key;
      if (isIdentifyingField(key)) {
        // A field that is present and null is *not* a finding: a nulled column is the
        // state a Phase 15 drop leaves behind, and reporting it would make the gate
        // fail on a record that is already correct.
        if (inner !== null && inner !== undefined) found.push({ path: childPath, field: key });
        continue;
      }
      walk(inner, childPath);
    }
  };
  walk(value, path || "");
  return found;
}

/**
 * Refuse a record that carries an identifying value.
 *
 * This is the schema rule of §23.7 expressed as a runtime guard, and it is applied
 * where the rule is stated to bind: the decision record and the input snapshot.
 *
 * @param {*} record
 * @param {string} what a human name for the record, used in the message
 * @throws {Error} naming every offending path
 */
function assertNonIdentifying(record, what) {
  const findings = scan(record);
  if (findings.length === 0) return;
  throw new Error(
    `${what || "this record"} holds identifying value(s) at ${findings.map((finding) => finding.path).join(", ")}. ` +
      "No decision record or input snapshot stores an identifying value directly; both store a stable surrogate key " +
      "into the identity store plus the derived, non-identifying quantities the decision actually consumed (§23.7). " +
      "A field whose erasure would change a replayed cost is an identifying field wrongly admitted into the decision path.",
  );
}

/**
 * Produce the derived, non-identifying quantities §23.7 admits into the decision path.
 *
 * Every quantity is supplied by a caller-injected resolver rather than computed here:
 * the fine cell comes from `spatial/cells.js`, the zone from the hierarchy, the routing
 * node from the routing graph. This module's job is to state *which six* and to refuse
 * anything else — including, especially, a raw coordinate that arrives under one of the
 * six names.
 *
 * @param {object} input the identifying record
 * @param {object} resolvers one function per quantity, each `(input) => value`
 * @returns {object} exactly the `DERIVED_QUANTITIES` keys, each null when unresolved
 */
function derive(input, resolvers) {
  const source = input || {};
  const bound = resolvers || {};
  const derived = {};

  for (const name of DERIVED_QUANTITIES) {
    const resolver = bound[name];
    derived[name] = typeof resolver === "function" ? resolver(source) ?? null : null;
  }

  // The derived set is itself scanned. A `zoneId` resolver that returned the address
  // string would otherwise put the address back into the decision path under a name the
  // register exempts, which is the one way this construction could be defeated silently.
  /** @structural the longest a cell id, zone id, class label, cohort or node id may be */
  const MAX_DERIVED_LENGTH = 128;
  for (const [name, value] of Object.entries(derived)) {
    if (typeof value === "string" && value.length > MAX_DERIVED_LENGTH) {
      throw new Error(
        `derived quantity "${name}" resolved to a ${value.length}-character string. A derived quantity is a cell, a ` +
          "zone, a class, a cohort, or a graph node id — not free text, which is where an address would re-enter (§23.7).",
      );
    }
  }

  return derived;
}

/**
 * The reference every decision record and snapshot holds in place of the identifying
 * value: the key, its subject type, and the derived quantities.
 *
 * @param {object} input `{ subjectType, naturalId, secret, identifying, resolvers }`
 * @returns {object} `{ identityKey, subjectType, ...derived }`
 */
function reference(input) {
  const source = input || {};
  const key = surrogateKey({ subjectType: source.subjectType, naturalId: source.naturalId, secret: source.secret });
  const record = {
    identityKey: key,
    subjectType: source.subjectType,
    ...derive(source.identifying || {}, source.resolvers),
  };
  assertNonIdentifying(record, "a surrogate reference");
  return record;
}

module.exports = {
  DIGEST_ALGORITHM,
  KEY_HEX_LENGTH,
  KEY_PREFIX,
  SUBJECT_TYPE,
  SUBJECT_TYPES,
  ERASED,
  IDENTIFYING_FIELDS,
  DERIVED_QUANTITIES,
  requireSecret,
  normaliseNaturalId,
  surrogateKey,
  isSurrogateKey,
  subjectTypeOf,
  isIdentifyingField,
  scan,
  assertNonIdentifying,
  derive,
  reference,
};
