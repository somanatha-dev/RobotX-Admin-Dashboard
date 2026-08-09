"use strict";

/**
 * Capability attestation (§23.2) — **Tier 1**, serving the Tier 0 capability gate F21.
 *
 * > **Capabilities are never accepted from agent telemetry.** They derive from the
 * > commissioning record plus a signed firmware/hardware attestation. A compromised
 * > agent claiming `hazmat_certified` must not thereby become eligible for hazmat work;
 * > this is precisely the kind of privilege escalation an untyped, self-declared
 * > capability field enables.
 *
 * ── Why "rejected entirely" and not "accepted with lower confidence" ────────
 * §23.5's table gives capability one word — *Rejected entirely* — where every other
 * agent-reported field gets a validation rule. The asymmetry is deliberate and it is
 * the point of this module. Position can be sanity-checked against physics; a
 * capability claim has nothing to check it against, because the claim *is* the fact.
 * There is no measurement that distinguishes an agent that is hazmat-certified from one
 * that says it is. So the only safe rule is that the claim never enters the bundle, and
 * `admitClaim()` exists to make that a function call somebody can point at rather than
 * an absence somebody has to notice.
 *
 * ── The two admissible origins, and their different shapes ──────────────────
 *   1. **The commissioning record.** A control-plane fact, written by an operator with
 *      the authority to write it, and already durable in `CapabilityBundle`. Phase 2
 *      built the bundle; this module is what decides whether a given entry belongs in it.
 *   2. **A signed firmware/hardware attestation.** A manifest the device produces and
 *      signs, verified here against the signer's key. This is what carries facts that
 *      *change* — installed firmware version, fitted compartment hardware — which a
 *      commissioning record cannot, because it was written once.
 *
 * An attestation **expires**. A manifest signed eighteen months ago describes a device
 * that has since been serviced, reflashed, and possibly rebuilt, and treating it as
 * current is how a stale fact becomes a wrong eligibility decision. `verify()` therefore
 * takes the evaluation time and the maximum age, and returns `EXPIRED` rather than a
 * bare false, because an expired attestation and a forged one need different responses.
 *
 * ── Relationship to `domain/capability.js` ──────────────────────────────────
 * Phase 2 left a seam: `capability.isAttested()` admits three source labels, and its
 * header records that "Phase 14 replaces the source check with signature verification
 * against the commissioning record and the firmware attestation". This module is that
 * replacement. It does not change `isAttested()` — the label check is still correct and
 * still the last line of defence inside the Tier 0 gate — it supplies the verification
 * that decides which capabilities may carry the label in the first place.
 */

const crypto = require("crypto");

const { canonicalJson } = require("../determinism/ordering");
const capability = require("../domain/capability");

/** @structural the attestation digest algorithm */
const DIGEST_ALGORITHM = "sha256";

/**
 * The origins a capability may lawfully come from, matching the three labels
 * `domain/capability.isAttested()` already admits.
 * @structural the admissible capability origins
 */
const ORIGIN = Object.freeze({
  COMMISSIONING_RECORD: "COMMISSIONING_RECORD",
  HARDWARE_MANIFEST: "HARDWARE_MANIFEST",
  FIRMWARE_ATTESTATION: "FIRMWARE_ATTESTATION",
});

const ORIGINS = Object.freeze(Object.values(ORIGIN));

/**
 * Origins that arrive over the agent's own data plane. Not a list of "less trusted"
 * sources — a list of sources from which a capability claim is **refused**.
 * @structural the refused origins
 */
const REFUSED_ORIGIN = Object.freeze(["TELEMETRY", "AGENT_REPORT", "SELF_DECLARED", "HEARTBEAT", "AUTH"]);

/** Verification outcomes. Distinguished so each can carry its own response. */
const VERIFICATION = Object.freeze({
  VALID: "VALID",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  EXPIRED: "EXPIRED",
  MALFORMED: "MALFORMED",
  UNKNOWN_SIGNER: "UNKNOWN_SIGNER",
  AGENT_MISMATCH: "AGENT_MISMATCH",
});

/**
 * The canonical bytes an attestation signature covers.
 *
 * The agent id is inside the signed form for the same reason it is inside a command
 * envelope (§23.3): a manifest signed without it is a manifest that can be lifted from
 * one device and presented by another, and a fleet of identical hardware is exactly the
 * situation where that works.
 *
 * @param {object} manifest
 * @returns {string}
 */
function canonicalManifest(manifest) {
  const source = manifest || {};
  if (typeof source.agentId !== "string" || source.agentId === "") {
    throw new TypeError(
      "an attestation covers the agent id it describes. Without it the manifest can be lifted from one device and " +
        "presented by another, which in a fleet of identical hardware is the normal case (§23.2).",
    );
  }
  return canonicalJson({
    agentId: source.agentId,
    issuedAt: source.issuedAt ?? null,
    notAfter: source.notAfter ?? null,
    firmwareVersion: source.firmwareVersion ?? null,
    hardwareRevision: source.hardwareRevision ?? null,
    secureElement: source.secureElement ?? null,
    capabilities: Array.isArray(source.capabilities) ? source.capabilities : [],
  });
}

/**
 * The manifest's content address, stored so a later dispute compares digests rather
 * than re-serialising a JSON blob and hoping the key order matched.
 *
 * @param {object} manifest
 * @returns {string}
 */
function manifestHash(manifest) {
  return crypto.createHash(DIGEST_ALGORITHM).update(canonicalManifest(manifest)).digest("hex");
}

/**
 * Sign a manifest. Present for the commissioning tool and for tests; the server never
 * signs an attestation in production, because the device does.
 *
 * @param {object} manifest
 * @param {string|Buffer|crypto.KeyObject} key an HMAC secret or a private key
 * @param {string} [algorithm] `HMAC` (default) or `ED25519`
 * @returns {string} hex
 */
function sign(manifest, key, algorithm) {
  const bytes = canonicalManifest(manifest);
  if (algorithm === "ED25519") {
    return crypto.sign(null, Buffer.from(bytes, "utf8"), key).toString("hex");
  }
  return crypto.createHmac(DIGEST_ALGORITHM, key).update(bytes, "utf8").digest("hex");
}

/**
 * Verify a signed attestation.
 *
 * @param {object} input
 * @param {object} input.manifest
 * @param {string} input.signature hex
 * @param {string} [input.algorithm] `HMAC` | `ED25519`
 * @param {string|Buffer|crypto.KeyObject} input.key the signer's key
 * @param {string} [input.agentId] the agent this attestation is being admitted for
 * @param {Date} input.now
 * @param {number} [input.maxAgeSeconds] `security.attestation_max_age`
 * @returns {{ outcome: string, ok: boolean, detail: string|null, manifestHash: string|null }}
 */
function verify(input) {
  const source = input || {};
  const manifest = source.manifest;

  if (!manifest || typeof manifest !== "object" || typeof manifest.agentId !== "string" || manifest.agentId === "") {
    return { outcome: VERIFICATION.MALFORMED, ok: false, detail: "the manifest names no agent", manifestHash: null };
  }
  if (source.key === undefined || source.key === null || source.key === "") {
    return { outcome: VERIFICATION.UNKNOWN_SIGNER, ok: false, detail: "no signer key was supplied for this attestation", manifestHash: null };
  }
  if (source.agentId !== undefined && source.agentId !== null && String(source.agentId) !== manifest.agentId) {
    return {
      outcome: VERIFICATION.AGENT_MISMATCH,
      ok: false,
      detail: `the manifest describes "${manifest.agentId}" and was presented for "${String(source.agentId)}"`,
      manifestHash: null,
    };
  }

  let expected;
  try {
    if (source.algorithm === "ED25519") {
      const verified = crypto.verify(null, Buffer.from(canonicalManifest(manifest), "utf8"), source.key, Buffer.from(String(source.signature || ""), "hex"));
      if (!verified) return { outcome: VERIFICATION.SIGNATURE_INVALID, ok: false, detail: "the manifest signature does not verify", manifestHash: null };
      expected = null;
    } else {
      expected = sign(manifest, source.key);
    }
  } catch (error) {
    return { outcome: VERIFICATION.MALFORMED, ok: false, detail: error?.message ?? "the attestation could not be canonicalised", manifestHash: null };
  }

  if (expected !== null) {
    const given = Buffer.from(String(source.signature || ""), "hex");
    const want = Buffer.from(expected, "hex");
    // Constant-time, for the reason `commandSigning.verify` states: an early-return
    // comparison leaks the prefix of a valid signature to anyone who can measure it.
    if (given.length !== want.length || want.length === 0 || !crypto.timingSafeEqual(given, want)) {
      return { outcome: VERIFICATION.SIGNATURE_INVALID, ok: false, detail: "the manifest signature does not verify", manifestHash: null };
    }
  }

  const now = source.now instanceof Date ? source.now : new Date();
  const notAfter = manifest.notAfter ? new Date(manifest.notAfter).getTime() : null;
  const issuedAt = manifest.issuedAt ? new Date(manifest.issuedAt).getTime() : null;
  /** @structural milliseconds per second */
  const MS_PER_SECOND = 1000;
  const maxAgeMs = Number.isFinite(source.maxAgeSeconds) ? Number(source.maxAgeSeconds) * MS_PER_SECOND : null;

  if (notAfter !== null && now.getTime() >= notAfter) {
    return { outcome: VERIFICATION.EXPIRED, ok: false, detail: `the attestation expired at ${new Date(notAfter).toISOString()}`, manifestHash: null };
  }
  if (maxAgeMs !== null && issuedAt !== null && now.getTime() - issuedAt > maxAgeMs) {
    return {
      outcome: VERIFICATION.EXPIRED,
      ok: false,
      detail:
        `the attestation was issued ${Math.round((now.getTime() - issuedAt) / MS_PER_SECOND)} s ago, beyond ` +
        `security.attestation_max_age. A manifest signed long enough ago describes a device that has since been ` +
        "serviced and reflashed; treating it as current is how a stale fact becomes a wrong eligibility decision.",
      manifestHash: null,
    };
  }

  return { outcome: VERIFICATION.VALID, ok: true, detail: null, manifestHash: manifestHash(manifest) };
}

/**
 * §23.2 / §23.5 — decide whether a capability claim may be admitted at all, by origin.
 *
 * This is the function that makes "rejected entirely" a thing the code does rather than
 * a thing the code omits. Every path that could carry a capability into the system calls
 * it, and the telemetry handler calls it on the whole payload.
 *
 * @param {object} claim `{ name, origin }`
 * @returns {{ admitted: boolean, reason: string|null, securityEvent: boolean }}
 */
function admitClaim(claim) {
  const source = claim || {};
  const origin = typeof source.origin === "string" ? source.origin.toUpperCase() : null;

  if (origin !== null && REFUSED_ORIGIN.includes(origin)) {
    return {
      admitted: false,
      securityEvent: true,
      reason:
        `capability "${String(source.name)}" arrived via ${origin} and is rejected entirely. Capabilities derive from ` +
        "the commissioning record plus a signed firmware/hardware attestation — never from agent telemetry. A " +
        "compromised agent claiming hazmat_certified must not thereby become eligible for hazmat work (§23.2, §23.5).",
    };
  }
  if (!ORIGINS.includes(origin)) {
    return {
      admitted: false,
      securityEvent: false,
      reason:
        `capability "${String(source.name)}" declares origin "${String(source.origin)}", which is not one of ` +
        `${ORIGINS.join(", ")}. Unknown is never permission (T2).`,
    };
  }

  return { admitted: true, reason: null, securityEvent: false };
}

/**
 * Scan an arbitrary agent-supplied payload for a capability claim.
 *
 * Telemetry is a `passthrough()` schema by design — an agent may report fields the
 * server does not model — which is precisely the gap a capability claim would arrive
 * through. This walks the payload for capability-shaped keys and reports every one.
 *
 * @param {*} payload
 * @returns {Array<{ path: string, key: string }>}
 */
function findCapabilityClaims(payload) {
  const CLAIM_KEYS = /^(capabilit(y|ies)|certifications?|attestedcapabilit(y|ies)|hazmatcertified|cold_?chain|clearance)$/;
  const found = [];

  const walk = (node, at) => {
    if (!node || typeof node !== "object" || node instanceof Date) return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${at}[${index}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const path = at ? `${at}.${key}` : key;
      if (CLAIM_KEYS.test(key.toLowerCase().replace(/[^a-z_]/g, ""))) {
        found.push({ path, key });
        continue;
      }
      walk(value, path);
    }
  };

  walk(payload, "");
  return found;
}

/**
 * Build the authoritative capability set for an agent from its admissible origins.
 *
 * The result is handed to `capability.assertAttested()` before it is returned, so a
 * defect in this function surfaces here rather than as an eligibility decision three
 * layers away.
 *
 * @param {object} input
 * @param {Array<object>} [input.commissioned] capabilities from the commissioning record
 * @param {object} [input.attestation] a *verified* manifest
 * @returns {{ capabilities: object[], rejected: object[] }}
 */
function capabilitiesFrom(input) {
  const source = input || {};
  const capabilities = [];
  const rejected = [];

  const admit = (entry, origin) => {
    const verdict = admitClaim({ name: entry?.name, origin });
    if (!verdict.admitted) {
      rejected.push({ name: entry?.name ?? null, origin, reason: verdict.reason, securityEvent: verdict.securityEvent });
      return;
    }
    capabilities.push({ ...entry, source: origin });
  };

  for (const entry of source.commissioned || []) {
    admit(entry, entry && entry.origin ? String(entry.origin).toUpperCase() : ORIGIN.COMMISSIONING_RECORD);
  }
  for (const entry of (source.attestation && source.attestation.capabilities) || []) {
    admit(entry, ORIGIN.FIRMWARE_ATTESTATION);
  }

  // The Tier 0 gate's own assertion, run here so a defect in this function is a failure
  // at the boundary rather than an eligibility decision three layers away.
  capability.assertAttested({ capabilities });

  return { capabilities, rejected };
}

/**
 * Persist a verified attestation.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ agentId, certificateId, manifest, signature, algorithm, signerKeyId, verification, now }`
 * @returns {Promise<object>}
 */
async function record(deps, input) {
  const source = input || {};
  const manifest = source.manifest || {};
  return deps.prisma.capabilityAttestation.create({
    data: {
      agentId: String(source.agentId),
      certificateId: source.certificateId ?? null,
      manifestHash: source.verification?.manifestHash ?? manifestHash(manifest),
      manifest,
      signature: String(source.signature || ""),
      algorithm: source.algorithm ?? "HMAC",
      signerKeyId: source.signerKeyId ?? null,
      issuedAt: manifest.issuedAt ? new Date(manifest.issuedAt) : null,
      notAfter: manifest.notAfter ? new Date(manifest.notAfter) : null,
      outcome: source.verification?.outcome ?? VERIFICATION.MALFORMED,
      verifiedAt: source.now instanceof Date ? source.now : new Date(),
    },
  });
}

module.exports = {
  DIGEST_ALGORITHM,
  ORIGIN,
  ORIGINS,
  REFUSED_ORIGIN,
  VERIFICATION,
  canonicalManifest,
  manifestHash,
  sign,
  verify,
  admitClaim,
  findCapabilityClaims,
  capabilitiesFrom,
  record,
};
