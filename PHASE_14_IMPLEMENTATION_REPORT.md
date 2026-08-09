# Phase 14 — Implementation Report

**Role:** Senior Distributed Systems Engineer implementing the frozen architecture
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 14 — Security, governance, and
privacy" (rows 685–708) and its §7 checklist (lines 1279–1295), implementing
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §23 in full and the remaining §22 governance surface
**Date:** 2026-08-09 · **Branch:** `feature/dashboard` · **Baseline:** Phase 13,
independently verified — uncommitted on top of `cf9103f`
**Phase 15 or later:** not implemented. No legacy service is retired, no legacy socket event
or Redis key is removed, no column is dropped, `ENGINE_ENABLED` remains `false`, and
`src/engine/fairness/` remains empty. All asserted mechanically — see §12.

---

## 1. Executive Summary

Phase 14 delivers §23 of the frozen architecture: mutual TLS with per-device certificates
and a session bound to `(agent_id, certificate, session_id)` with revocation checked at
establishment **and** periodically (§23.2); capability attestation, with a claim arriving on
the agent's data plane rejected entirely (§23.2, §23.5); command integrity completed with an
asymmetric signing scheme beside Phase 4's HMAC and every rejection counted by scope
(§23.3); scoped RBAC/ABAC over §23.4's four high-privilege action classes; the six §23.5
trust-boundary rows including the asymmetric health rule; §23.6's override discipline with
class I, R and F absolute, every decision audited twice, and override rates monitored per
operator and per predicate; and §23.7's privacy separation — surrogate keys, an encrypted
access-controlled identity store, and erasure that tombstones identity while leaving the
technical record replayable.

Seven new engine modules, one background worker, one REST route pair, one build gate, one
migration tool, four new Prisma models, thirteen new columns, thirteen new registered
parameters, one new publish-time validation, and twelve new test files (**232 tests**).
Fifteen existing files were rewired.

`npm run verify` — now five build gates, then all three Jest lanes — is green: **128 suites,
5,885 tests, 0 failures.** The legacy lane is unchanged at **169/169**, the baseline every
phase since 10 has reported, confirming zero behavioural regression in the path Phase 15's
cutover has not yet reached. The gates lane rises from 49 to **58** with the new gate's own
self-test.

**Five things are worth a verifier's attention up front**, each recorded rather than
smoothed over:

1. **The erasure build gate is real, and it is proved able to fail.** §23.7 nominates its
   own gate — the reconstruction-equivalence test re-run over an erased corpus. It is
   implemented as a second run of the *same* function over the *same* corpus with
   `privacy/erasure.eraseCorpus()` applied to the inputs, wired into `npm run gates` as
   `gate:erasure`. On the shipped corpus it removes **zero** identifying fields and changes
   nothing, which is the positive statement §23.7 wants. `privacyErasure.test.js` then plants
   the realistic defect — a geofence predicate recording a raw address in its free-form
   `observed` block — and asserts the erased run diverges and names the field. §13 item 1
   records what the shipped corpus does and does not prove.

2. **The identity-isolation gate is deliberately narrow, and the narrowness is disclosed.**
   The checklist's gate is "no identifying value is an input to any cost term", and
   `tools/gates/checkIdentityIsolation.js` enforces exactly that over `src/engine/cost/**`
   plus the four modules that build a decision record or a snapshot. It does **not** scan
   candidate generation, feasibility or the plan builder, which do read coordinates —
   `lowerBound.js` computes a great-circle bound and `f33.js` evaluates a geofence, both in
   order to *produce* one of §23.7's admissible derived quantities. Widening the gate would
   fail correct code. §13 item 2 states the bound this leaves and what covers it instead.

3. **Legacy identifying columns are retained, not dropped.** §23.7 reads as though
   `Stop.label`, `Stop.lat/lon`, `Task.pickup` and `Task.drop` should go in this migration.
   They do not, because the plan gives Phase 15 the drop — "Drop legacy columns **only
   after** a full retention window with the new path live" — and the legacy dispatcher,
   still the production path, reads every one of them. What lands complete here is the half
   §23.7 makes binding: the decision-record and snapshot schemas, the runtime guard, and the
   two build gates. `backfillIdentities.js` has a `--redact` flag for the Phase 15 window and
   it is not the default.

4. **mTLS is additive today and mandatory by a flag.** The plan's own risk note for this
   phase is "changes the agent handshake; requires coordinated firmware rollout". A server
   that could only speak the new handshake would disconnect every un-updated device — and
   the simulated fleet, which is the substrate every other phase's tests run on — at the
   moment of deploy. There are three states, and which applies is a deployment decision:
   legacy pairing when no certificate is presented and `AGENT_MTLS_REQUIRED` is unset; full
   validation and binding whenever a certificate *is* presented, so a real certificate is
   never ignored; and refusal of any certificate-less session once the flag is set. Pairing
   is then refused **by name** rather than by falling through.

5. **`config.routes.js` and `shards.routes.js` each carried their own `ELEVATED_ROLES`
   constant, and now neither does.** Both files contained a comment saying the other existed
   and that Phase 14 would land authorisation properly. The list is now
   `security.elevated_roles` in the parameter register, Safety-class, resolved by one
   middleware; its default is byte-for-byte the value both files held, so nothing changes
   behaviourally on the day it lands. `securityAuthorisation.test.js` asserts no route file
   carries a copy.

---

## 2. Objectives Achieved

Cross-referencing the Phase 14 checklist (§7, lines 1279–1295) item by item:

| # | Checklist item | Status |
|---|---|---|
| 1 | mTLS with per-device certificates; keys in a secure element where available | **Done** — `security/sessionBinding.js`; `AgentCertificate.keyStorage` is per device with `UNKNOWN` distinct from `SOFTWARE`; §1 item 4 records the staging |
| 2 | Revocation check at session establishment **and** periodically during long sessions | **Done** — both halves: `establish()` at the handshake, `dueForRecheck`/`recheck` on the heartbeat and in `certificateRotation.worker.js` |
| 3 | `security/sessionBinding.js` — `(agent_id, certificate, session_id)` | **Done** — all three compared on every check, not only at establishment |
| 4 | `security/attestation.js` — capability from commissioning record + signed attestation only | **Done** — two admissible origins, signature over a canonical manifest including the agent id, plus expiry and a staleness bound |
| 5 | Reject any capability claim arriving via telemetry | **Done** — `admitClaim()` refuses every data-plane origin; `findCapabilityClaims()` walks the `passthrough()` payloads; the TELEMETRY frame is **dropped**, not stripped |
| 6 | Complete `security/commandSigning.js` — signature over the whole payload including agent id | **Done** — `ALGORITHM.ED25519` beside Phase 4's HMAC, envelope byte-for-byte unchanged; rejections now carry their fence scope |
| 7 | `security/trustBoundaries.js` — the six §23.5 rows incl. asymmetric health trust | **Done** — six rows as data, six validators, `assertCoverage()` at load |
| 8 | `security/override.js` — class I/R/F never waivable; scoped, reasoned, audited, second approver | **Done** — and the refusal is issued *before* the actor is consulted; also enforced at the store by a CHECK |
| 9 | Monitor override rates per operator and per predicate as a design signal | **Done** — `rates()`/`breaches()`, per predicate first, findings naming the interpretation not the count |
| 10 | `privacy/identityStore.js` and `surrogateKeys.js` | **Done** — keyed stable surrogate keys, AES-256-GCM at rest, audited resolve |
| 11 | Migrate decision records and snapshots to hold **only** surrogate keys and derived non-identifying quantities | **Done for the records §23.7 binds; disclosed for the legacy columns** — §1 item 3, §13 item 3 |
| 12 | `privacy/erasure.js` — tombstone identity, leave the technical record replayable | **Done** — tombstone rule also enforced by a CHECK; a re-run backfill cannot undo an erasure |
| 13 | REST: `POST /api/privacy/erasure` | **Done** — §7; dry-run by default |
| 14 | **Build gate:** reconstruction-equivalence re-run over an erased corpus still reproduces Tier B byte-for-byte | **Done** — `npm run gate:erasure`; §1 item 1 |
| 15 | **Gate:** no identifying value is an input to any cost term | **Done, with a stated scope** — `npm run gate:privacy`; §1 item 2, §13 item 2 |
| 16 | Governance: two-person approval sets for Safety-class changes; override rate thresholds per operator and per predicate | **Done** — `security.second_approver_action_classes` (union-only), `security.override_rate_threshold_per_{operator,predicate}` |

---

## 3. Files Created

**Engine modules (7):**

| File | Lines | Purpose |
|---|---|---|
| `src/engine/security/override.js` | 571 | §23.4, §23.6 — waivability, action classes, scoping, audit shapes, rate monitoring |
| `src/engine/security/trustBoundaries.js` | 486 | §23.5 — the six rows, the asymmetric rule, persistent implausibility |
| `src/engine/security/sessionBinding.js` | 452 | §23.2 — certificates, the binding, revocation, rekey |
| `src/engine/privacy/surrogateKeys.js` | 449 | §23.7 — the key, the identifying register, the six derived quantities |
| `src/engine/security/attestation.js` | 374 | §23.2 — manifest verification, origin admission, capability derivation |
| `src/engine/privacy/identityStore.js` | 338 | §23.7 — encryption at rest, classification, audited resolve, tombstone |
| `src/engine/privacy/erasure.js` | 291 | §23.7 — request validation, plan, apply, redact, the corpus erasure |

**Worker (gated, not scheduled):** `src/workers/certificateRotation.worker.js` (235) — the
periodic revocation sweep, the rotation report, and the identity retention sweep.

**REST:** `src/controllers/privacy.controller.js` (155), `src/routes/privacy.routes.js` (27).

**Build gate:** `tools/gates/checkIdentityIsolation.js` (191).

**Migration tool:** `tools/migrate/backfillIdentities.js` (335).

**Migration:** `prisma/migrations/20260809090000_security_governance_privacy/migration.sql`
(349 lines).

**Tests (2,616 lines, 232 tests):** `securitySchema` (335), `securityTrustBoundaries` (274),
`securitySessionBinding` (257), `privacyErasure` (252), `securityOverride` (251),
`certificateRotationWorker` (219), `securityAuthorisation` (210), `securityAttestation`
(172), `privacyApi` (171), `privacySurrogateKeys` (161),
`securityCommandIntegrity` (145), and `tests/gates/checkIdentityIsolation` (169).

**Four files created beyond the plan's enumerated list, and why.** The plan names eight
engine modules (one of which, `commandSigning.js`, already existed) and one worker; its REST
row specifies one new endpoint. `privacy.controller.js` and `privacy.routes.js` are that
endpoint's home, mounted at `/api/privacy` beside every other authenticated operator surface
since Phase 5 — the same disposition Phase 12 recorded for `health.controller.js` and Phase
13 for `shards.controller.js`. `tools/gates/checkIdentityIsolation.js` is checklist item 15,
which asks for a gate and does not name a file. `tools/migrate/backfillIdentities.js`
follows Phase 2's `backfillDomain.js` precedent: the migration adds nullable columns and
something has to fill them, idempotently and re-runnably.

## 4. Files Modified

| File | Change |
|---|---|
| `Backend/prisma/schema.prisma` | Four models added; thirteen columns added across `Stop`, `Task`, `DecisionRecordA/B`, `InputSnapshot`, every one nullable with no default |
| `Backend/src/engine/security/commandSigning.js` | `ALGORITHM` (`HMAC_SHA256` \| `ED25519`), `algorithmOf`, asymmetric `sign`/`verify`, `scopeOfEnvelope`; `admitEnvelope` gains `scope`. **`SIGNED_FIELDS`, `canonicalise` and `FIELD_SEPARATOR` are unchanged** |
| `Backend/src/middlewares/auth_middleware.js` | `requireElevatedRole()`, `requireActionClass()`, `policyFor`, `configValue`, `recordAuthorisation`. **`authUser` and `verifyUserToken` are unchanged** |
| `Backend/src/sockets/handlers/robot.handler.js` | Certificate-bound session establishment before the pairing and token branches; pairing refused by name under mTLS; capability claims rejected; `SESSION_REKEY` issued and `SESSION_REKEY_ACK` handled; periodic revocation check on the heartbeat; `AUTH_SUCCESS` gains a `session` descriptor |
| `Backend/src/sockets/handlers/telemetry.handler.js` | Capability claims reject the frame; §23.5 position and energy validation with per-agent refusal counting and a `SECURITY_EVENT` broadcast on persistent implausibility; computed-not-enforced while `ENGINE_ENABLED` is false |
| `Backend/src/controllers/robots.controller.js` | `clear-fault` refuses a predicate-waiver request by name and records actor and reason on the `Event` row |
| `Backend/src/controllers/tasks.controller.js` | `assign` authorises a named waiver against the feasibility register's own class before anything else |
| `Backend/src/routes/robots.routes.js` | `clear-fault` and `pairing/unlock` gated as `QUARANTINE_OVERRIDE` |
| `Backend/src/routes/tasks.routes.js` | `assign` conditionally gated as `MANUAL_ASSIGNMENT_AGAINST_POLICY` |
| `Backend/src/routes/config.routes.js` | Local `ELEVATED_ROLES` retired; `publish` gated as `SAFETY_CONFIG_CHANGE` |
| `Backend/src/routes/shards.routes.js` | Local `ELEVATED_ROLES` retired |
| `Backend/src/routes/index.js` | `/api/privacy` mounted |
| `Backend/src/config/cors.js` | `tlsPosture()`; the no-Origin comment restated for a certificate-bound agent surface |
| `Backend/server.js` | TLS posture logged at boot; certificate worker started, gated on `ENGINE_ENABLED`; stopped on shutdown |
| `Backend/src/engine/config/validators.js` | New `a5IdentityRetentionOrdering`, wired into `validatePublish` |
| `Backend/src/engine/config/register/supplementary.json` | 13 new entries. Purely additive; no existing entry touched |
| `Backend/package.json` | `gate:privacy`, `gate:erasure`, both added to `gates` |
| `Backend/tools/replay/replayDecision.js` | `runCorpus({ erased })`, the `--erased` CLI flag, and the erasure-defect message |
| `Backend/.env`, `.env.benchmark`, `tests/setup/env.js` | `AGENT_MTLS_REQUIRED=false`, set explicitly |
| Six test files | Boundary assertions moved forward — see §11 |

**Neither `commit.js`, `TIERS.md` nor `guards/tierAssertions.js` was modified.** §1.8 names
no §23 mechanism as Tier 2, so `src/engine/security/` and `src/engine/privacy/` take the
Tier 1 default for `src/engine/`; a `MODULE_TIERS` row would have been this phase
reclassifying a mechanism the specification classified. `securitySchema.test.js` asserts both
the tier and that `commit.js` names no §23 identifier.

---

## 5. Database Changes

Additive only. **No `DROP`, no `RENAME`, no `ALTER COLUMN`.** Every added column is nullable
with no default, so every existing row remains valid and no legacy write path acquires a new
requirement — the treatment Phases 2 and 5 gave their additive columns.
`securitySchema.test.js` asserts all three properties over the migration with its comments
stripped, and asserts the set of pre-existing tables it alters is exactly the five the plan
names.

**Four new tables.**

`AgentCertificate` — §23.2's per-device certificate. `fingerprint` is unique and is the
lookup key, never the PEM: a PEM comparison is defeated by re-wrapping the same certificate
at a different line length, and it would put a public key into every log line reporting a
mismatch. `agentId` is a plain string rather than a foreign key, because commissioning
issues a certificate to a *device* and §25 admits agents with no `Robot` row that may not yet
have an `Agent` projection — a foreign key would make the certificate un-issuable until the
projection existed, inverting the order the two actually happen in. `rotatedFromId` is
self-referential so a rotation is a chain an incident can walk backwards. There is a
`publicKeyPem` column and deliberately no private-key column: a secure element exports a
public key and never a secret, and a column that could hold one is a column somebody
eventually puts one in.

`CapabilityAttestation` — the signed firmware/hardware manifest, stored **whole** beside its
content hash and its verification `outcome`, **including the failures**. A table keeping only
successes would answer "no attestation was presented" to a question whose true answer was
"eleven were presented and none verified".

`IdentityRecord` — §23.7's separate store. The identifying fields are AES-256-GCM
ciphertext, so a database backup that leaves the building is ciphertext and an edited
ciphertext fails to decrypt rather than decrypting to something else. `fieldNames` is in the
clear because names are not values, and keeping them is what lets an erasure report say
*what* was erased without decrypting anything. Erasure nulls the three sealed columns and
stamps `erasedAt`; the row and its `surrogateKey` survive, because deleting it would make an
erased key indistinguishable from one never minted and the Explanation API could no longer
honestly answer `ERASED` rather than "unknown".

`OverrideAudit` — §23.6's queryable half. Two records exist per decision on purpose:
`AuditEvent` is the hash-chained, tamper-evident stream, and this is the one aggregations run
over, because "how often has F9 been waived in region R this quarter" is a `GROUP BY` and a
hash chain is not a thing one groups by. `auditEventHash` joins them. **Refusals are rows**,
which is the row an investigation most wants.

**Thirteen added columns.** `Stop` gains `identityKey` plus the six derived quantities named
identically to `surrogateKeys.DERIVED_QUANTITIES`, so the register and the columns cannot
silently diverge. `Task` gains `originIdentityKey` and `destinationIdentityKey` — two keys,
not one, because pickup and drop are two different premises and one key over both would make
an erasure request for either erase the other. `DecisionRecordA`, `DecisionRecordB` and
`InputSnapshot` each gain `surrogateKeys`.

Written as **one `ALTER TABLE` per column** rather than Prisma's multi-column form. That is
not cosmetic: `domainSchema.test.js` subtracts later-added columns from its generated-SQL
comparison by matching `ALTER TABLE "<t>" ADD COLUMN "<c>"`, which sees only the first column
of a multi-column statement. Writing seven statements instead of one keeps a three-phase-old
comparison honest; writing one would have silently re-broken it. `securitySchema.test.js`
asserts the style.

**Sixteen CHECK constraints**, each a §23 sentence made a property of the database.
`securitySchema.test.js` asserts every one is present in the migration and **absent** from
Prisma's generated output, which is what proves they are genuine hand-written additions
rather than an echo. Two are worth naming:

- `OverrideAudit_absolute_classes_never_granted` — `CHECK (NOT ("granted" AND
  "constraintClass" IN ('I','R','F')))`. `override.js` refuses before it looks at the actor;
  this refuses even if that module is bypassed, which is what makes §23.6's first rule a
  property of the system rather than of one module. A *refusal* row against those classes is
  explicitly permitted.
- `IdentityRecord_erased_has_no_ciphertext` — an erased row holds no ciphertext, and an
  unerased row holds all three sealed components or none. "The erased content is genuinely
  unrecoverable" cannot be left to whichever code path performed the update.

---

## 6. Runtime Behaviour

**Nothing changes for a running fleet by default.** `ENGINE_ENABLED` remains `false` and
`AGENT_MTLS_REQUIRED` defaults to `false`. Concretely, in the shipped configuration:

- An agent that presents no client certificate authenticates exactly as before — pairing
  code, session token, F32 lockout, all unchanged. The legacy lane's 169 tests confirm it.
- An agent that *does* present a certificate is validated and bound immediately. There is
  no window in which a real certificate is ignored in favour of a weaker credential.
- The §23.5 position and energy checks run on every telemetry frame and are **logged, never
  enforced**, while `ENGINE_ENABLED` is false — §21.6's shadow discipline applied to a
  security control, so the refusal rate is observable before it is load-bearing. The
  capability-claim rejection is *not* gated: a capability claim has no legitimate reading,
  and there is no rate to observe first.
- The certificate worker is built, tested and **not scheduled** unless `ENGINE_ENABLED` is
  true — the disposition every engine worker since Phase 4 has carried.
- Every REST gate is live immediately. That is a deliberate exception to the pattern: an
  authorisation control staged behind a flag is an authorisation control that is off. The
  behavioural cost is bounded and stated in §7.

**Under `AGENT_MTLS_REQUIRED=true`**, an agent session without a valid, unrevoked certificate
is refused, and the pairing branch refuses by name. A deployment that sets the flag without a
TLS terminator forwarding certificates loses its whole fleet at once and loudly — the correct
failure, because the alternative is accepting agents unauthenticated while believing mTLS is
on, which nobody notices.

**`SESSION_REKEY` is operational.** It has existed in §10.3.1's agent-scope table since Phase
3 and `VirtualRobot` has accepted it since Phase 4; nothing issued one. Two server-observed
conditions now do: the binding has passed `security.session_max_age`, or the periodic
revocation re-check is due. It rides the heartbeat because the heartbeat is the one event
that proves the socket is alive. The agent id is **not** a parameter of `rekey()`: a rekey
that could change which agent a session speaks for would be a privilege escalation wearing
the name of a maintenance operation.

---

## 7. API Changes

**New.**

| Endpoint | Auth | Behaviour |
|---|---|---|
| `POST /api/privacy/erasure` | `authUser` + elevated | **Dry run by default.** Returns the plan; `dryRun: false` tombstones and audits inside one transaction. Body is `strict()`: an unknown field is refused, never ignored |
| `GET /api/privacy/identity/:identityKey` | `authUser` + elevated | `RESOLVABLE` \| `ERASED` \| `NOT_FOUND`, with field **names** and never values |

**Changed — elevated-role and action-class gates.** These are behaviour changes to existing
endpoints, and they are the point of §23.4 rather than a side effect:

| Endpoint | Gate | Requires |
|---|---|---|
| `POST /api/config/publish` | `SAFETY_CONFIG_CHANGE` | elevated role, `X-Override-Reason`, distinct `X-Second-Approver` |
| `POST /api/robots/:robotId/clear-fault` | `QUARANTINE_OVERRIDE` | as above |
| `POST /api/robots/:robotId/pairing/unlock` | `QUARANTINE_OVERRIDE` | as above |
| `POST /api/tasks/assign` | `MANUAL_ASSIGNMENT_AGAINST_POLICY`, **conditionally** | only when the body both names an agent and asks to waive a predicate |

The publish gate does **not** replace §22.3's own two-person check. `config/service.js`'s S2
has enforced that since Phase 1 against the *published parameter set*, and it fires only when
the publish actually touches a Safety-class parameter — which this gate cannot know before
the body is validated. §23.4's list is about the route; §22.3's rule is about the change.
`configApi.test.js` asserts a publish that satisfies the gate is still refused by S2.

The conditional form on `assign` is doing real work rather than anticipating a feature.
`task.service.assignTask` parses with `passthrough()`, so before this phase a `waivePredicate`
field was **silently dropped**: the caller believed they had waived a constraint and the
server believed nothing had been asked. Turning that into an explicit authorisation — which
for a class I or R predicate is an explicit refusal — is strictly safer than the silence it
replaces.

**Unchanged.** `POST /api/tasks/:taskId/cancel`, `POST /api/tasks/:taskId/reroute`,
`GET /api/shards`, every diagnostic read, and every legacy contract. §23.4's fourth action
class, **bulk cancellation, has no endpoint** — `cancel` takes one id from the path and there
is no batch form. The class is registered and `securityAuthorisation.test.js` asserts both
halves: all four classes present, and no route accepting a list of task ids. Inventing a bulk
endpoint in order to gate it would be this phase adding a capability rather than securing
one.

---

## 8. Redis Changes

**`session:*` is retained and its contents replaced.** It held a bearer token that was, on
its own, sufficient to authenticate; it now holds the `(agent_id, certificate, session_id)`
binding, which is meaningless without the certificate whose fingerprint it names. The
namespace is reused rather than a second one minted, so a deployment cannot end up with both
authentication schemes alive at once. The **certificate** — its status, revocation and
rotation lineage — is durable in `AgentCertificate`; the binding in the cache is live state.
That split is §3.3's cache-authority rule applied to authentication: a cache miss costs a
store read and never a wrong answer, and a cache that claimed a revoked certificate was live
would be a cache promoted to an authority.

**`pairing:*`, `pairingAttempts:*`, `pairingLocked:*` are retained for commissioning.** Under
`AGENT_MTLS_REQUIRED=true` they are unreachable from a steady-state connection, which is the
plan's "retained for commissioning only". They are not deleted, because pairing *is* the
commissioning bootstrap and because their removal from the legacy path is Phase 15's.

**No new key is introduced.**

---

## 9. Socket.IO Changes

- **The handshake accepts and binds a client certificate**, from Node's own
  `getPeerCertificate()`, from an `x-client-cert` header a TLS-terminating proxy forwards, or
  from the auth payload for the simulator and tests. The header name is explicit rather than
  scanned for, because a wildcard scan over headers is a wildcard an attacker can also write
  to.
- **`AUTH_SUCCESS` / `AUTH_OK` gain a `session` descriptor** — mode, session id, fingerprint,
  key storage, expiry. Additive; every existing field is unchanged. An agent that believes it
  is certificate-bound while the server admitted it on a pairing code is a device whose
  operator cannot answer a security question about it.
- **`SESSION_REKEY` is emitted and `SESSION_REKEY_ACK` is handled**, with the rekey command
  carrying its own short `not_valid_after` (§23.3): a rekey that surfaced twenty minutes late
  would rotate a binding the server has already replaced.
- **A `SECURITY_EVENT` is broadcast to the dashboard room** on persistent implausibility,
  carrying the agent, the consecutive count and the reason. Dashboard-scoped, like every
  operator-facing event since Phase 12.
- **A TELEMETRY frame carrying a capability claim is dropped**, not stripped. Stripping would
  let an agent that is trying to escalate carry on reporting position as though nothing had
  happened, with the security event the only trace; dropping makes the attempt cost the
  attacker their telemetry, which is the correct incentive.
- **Every command already carried fence scope, fence value, sequence, `not_valid_after` and a
  signature over the payload including the agent id** — Phase 4's envelope, unchanged. What
  Phase 14 adds is the asymmetric scheme beside the HMAC one and the fence scope on every
  rejection.

---

## 10. Architecture Compliance

**Layering and ownership.** The seven new modules are L1/L2 policy and hold no decision
logic. `security/` and `privacy/` are Tier 1 by the default rule; the tier-dependency gate
reports 270 modules and 364 governed edges with no Tier 0/1 → Tier 2 dependency.
`override.js` imports Tier 0 `feasibility/threeValued.js` for the class vocabulary, which is
permitted and is the point — a second copy of "which classes are absolute" is a second copy
that can disagree.

**T1 (safety constraints are absolute and never priced).** The feasibility gate is
untouched, and `securityOverride.test.js` scans `evaluate.js`'s *code* — not its comments,
which promise the property — for `skipPredicates`, `waivePredicate`, `waivedPredicates`,
`manualOverride` and `bypass`, and finds none. A granted class P waiver is expressed as a
waived predicate id the caller applies to the gate's *result*, never as an argument that
changes how the gate ran. A gate that never takes a waiver cannot be made to honour one by
accident.

**T2 (unknown is never permission).** Applied throughout: an unknown certificate, an unknown
capability origin, an unknown constraint class, an unknown action class and an unknown
signature algorithm are each refused rather than defaulted. `validatePosition` with no prior
fix or no stated ceiling returns `INDETERMINATE` rather than accepting — §7.3's three-valued
discipline one layer out — and an uncorroborated custody event is `INDETERMINATE`, not
accepted.

**T6 / I10 (determinism and replay).** The erasure gate is the evidence, not an assertion:
erasure applied to the pinned inputs changes no replayed byte. Nothing in `security/` or
`privacy/` is in the decision path; the tenets gate reports 267 modules with no wall-clock or
unseeded-random read in the L4 scope.

**T8 / §23.7 (what is lost is stated rather than discovered).** `ERASED` is a distinguishable
answer from `NOT_FOUND` at the store, in `identityStore.resolve()`, in `erasure.redact()` and
on the HTTP surface.

**§22.3 (no automated tuner may modify a Safety-class parameter).** Unchanged and untouched.
The five new Safety-class parameters inherit S1 and S2 automatically, and A5 is added beside
V6 so the retention ordering `identity < technical ≤ snapshot` is a published property rather
than an intention.

**§3.3 (cache-authority rule).** Not relaxed: the certificate is DB-authoritative and the
binding is cache-resident live state.

**Backwards compatibility.** The legacy lane is unchanged at 169/169. The four route
behaviour changes are deliberate §23.4 requirements and are enumerated in §7.

---

## 11. Test Results

`npm run verify` — five gates, then three lanes:

```
gate: tier-dependencies (§1.8 rule 2)
  PASS — 270 module(s), 364 governed import edge(s), no Tier 0/1 → Tier 2 dependency.
gate: parameter-register (§22, Appendix A)
  PASS — 174 engine module(s) checked against 236 registered parameter(s).
gate: tenets (T1 type separation, T6 decision-path determinism)
  PASS — 267 module(s) checked, no violations.
gate: identity-isolation (§23.7)
  PASS — 16 module(s) in the cost and decision-record scopes hold no identifying field.
gate: reconstruction-equivalence over an ERASED corpus (§23.7, §24.3)
  PASS — 3 corpus decision(s), 3 with a Tier B record, reproduced byte for byte;
         erasure removed 0 identifying field(s) and changed no replayed cost.

Test Suites: 128 passed, 128 total
Tests:       5885 passed, 5885 total
```

Per lane: **legacy 169/169** (unchanged baseline), **gates 58/58** (was 49), **engine
5,658/5,658**.

**What the new tests prove, and where each gate is shown able to fail:**

| Suite | Tests | The property it defends |
|---|---|---|
| `securitySchema` | 52 | The migration is Prisma's own DDL; the sixteen CHECKs are genuine additions; the thirteen register entries resolve; A5 fires at equality and beyond; Phase 15's drop has not happened early |
| `securityTrustBoundaries` | 28 | All six §23.5 rows, the asymmetry in both directions, a completion from an unreachable position as a *security event*, and an uncorroborated custody event as `INDETERMINATE` |
| `securityOverride` | 25 | Every class I/R/F predicate in the register is unwaivable; the refusal precedes the role check; the feasibility gate still has no bypass; rates and breaches |
| `securitySessionBinding` | 19 | Fingerprint equivalence across three encodings; revocation reported before expiry; all three binding components compared; a rekey cannot change the agent |
| `securityAttestation` | 16 | Every refused origin refused; a manifest lifted from another device rejected; expiry and staleness distinguished; Ed25519 round trip |
| `privacyErasure` | 14 | The tombstone; the audit that survives it; a re-run backfill that cannot undo it; **the gate failing on a planted identifying field that is consumed** |
| `securityAuthorisation` | 14 | The four action classes at the REST surface, refusals audited, and bulk cancellation's absence asserted rather than assumed |
| `privacySurrogateKeys` | 20 | Stability, typing, unenumerability, the register's true and false positives, and the seal's tamper-evidence |
| `securityCommandIntegrity` | 12 | Phase 4's envelope byte-for-byte unchanged; Ed25519 verified with a public key alone; an expired command rejected; rejections scoped |
| `privacyApi` | 12 | Dry-run default; `strict()` body; the requester taken from the session; `ERASED` distinguished from `NOT_FOUND` |
| `certificateRotationWorker` | 11 | The periodic half; a failed tick delays a revocation and never grants one; the worker touches no socket |
| `checkIdentityIsolation` (gates) | 9 | A planted address in a cost term fails; the same planted in an out-of-scope module does not; an unexplained exemption fails |

**The plan's four stated testing requirements**, discharged:

1. *"capability claimed via telemetry is rejected entirely"* — `securityAttestation` (every
   refused origin) and `securityTrustBoundaries` (row 5, always refused).
2. *"self-reported health accepted for restricting but never for expanding eligibility"* —
   `securityTrustBoundaries`, both directions plus the general rule.
3. *"a completion claim from a kinematically unreachable position is rejected and raises a
   security event"* — `securityTrustBoundaries`, asserting the *security event*, not merely
   the rejection.
4. *"Integration: expired `not_valid_after` command rejected"* — `securityCommandIntegrity`.
5. *"Erasure gate: the reconstruction-equivalence test re-run over a corpus with erasure
   applied MUST still reproduce Tier B byte-for-byte"* — `npm run gate:erasure`, plus
   `privacyErasure`'s planted failure.

**Six existing test files were updated**, each because a boundary moved forward rather than
because an assertion was inconvenient:

| File | Change |
|---|---|
| `phase0Scaffold.test.js` | `PHASE_14_OWNED` added to the cumulative ownership walk, named file-by-file; `fairness/` still forbidden |
| `commitmentSchema.test.js` | Phase 14's four tables asserted **present**; the boundary becomes "no Phase 15 column drop has happened early" |
| `costSchema.test.js` | Boundary becomes "no decision-record table has acquired an identifying column", checked against the live register |
| `degradedSchema.test.js` | `security/` and `privacy/` asserted to hold exactly what Phases 4 and 14 own |
| `shardSchema.test.js` | Boundary becomes "Phase 14 did not touch the commit path" |
| `observabilitySchema.test.js` | Its byte-identical CREATE TABLE comparison now subtracts columns later migrations add — a subtraction, not a relaxation; a column no later migration adds still has to match |
| `configApi.test.js` | Publish requests carry the §23.4 headers; four new tests for the gate's own refusals and for S2 surviving it |
| `dispatchSchema.test.js` | `admitEnvelope`'s verdict gains `scope` |

---

## 12. Self-Verification

**Every Phase 14 requirement implemented.** §2 walks the sixteen checklist items. Two carry
a stated qualification (items 11 and 15) and both are recorded in §13 rather than in a
footnote.

**No Phase 15 functionality.** Asserted mechanically:

- No service retired — `taskAssignment.service.js`, `costEvaluator.service.js`,
  `robotValidator.service.js` and `taskRecovery.service.js` are all present and unmodified.
- No column dropped — `commitmentSchema.test.js` asserts `Stop.label`, `Stop.lat`,
  `Stop.lon` and `Robot.currentTaskId` are still present; `securitySchema.test.js` asserts the
  migration contains no `DROP`.
- No legacy socket event or Redis key retired.
- `ENGINE_ENABLED` unchanged at `false` in `.env`, `.env.benchmark` and `tests/setup/env.js`.
- No `formal/`, `tests/chaos/`, `tests/scale/`, `tools/simFidelity/` or `docs/safety-case/`.
- `src/engine/fairness/` still holds no `.js`.

**Architecture unchanged.** No file under `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` or
`IMPLEMENTATION_EXECUTION_PLAN.md` was edited. No ADR was required, because nothing in this
phase required a specification change.

**Tests pass; build passes.** §11.

**APIs remain compatible**, with the four deliberate §23.4 gates enumerated in §7. No
response field was removed or re-typed; `AUTH_SUCCESS` and `admitEnvelope` gained fields and
lost none.

**One thing I got wrong during implementation, recorded because a verifier should see it.**
My first `checkIdentityIsolation` run failed on `shadowLabel` in three modules: the register
matches `label` as a suffix, and §21.6's shadow discriminator ends in it. The fix was to
enumerate the collision in `EXEMPT_FIELDS` with its reason, **not** to stop matching `label`
as a suffix — because `pickupLabel` and `dropLabel` must keep matching, and the cost of
enumerating one collision is far lower than the cost of loosening the rule. The same class of
mistake bit three test assertions that scanned source text without stripping comments, each
matching the sentence that documented the absence of the thing being checked; all three now
scan `codeOnly()`.

---

## 13. Known Limitations

1. **The shipped replay corpus contains no identifying field, so the erased run removes
   nothing.** That is the correct state and the gate reports it as evidence — "erasure
   removed 0 identifying field(s) and changed no replayed cost" — but it means the *shipped*
   corpus does not exercise a divergence. The divergence is exercised by
   `privacyErasure.test.js`, which plants an identifying field that the reconstruction
   consumes and asserts the gate catches it and names the field. A verifier should treat the
   gate as proven by that test rather than by the CLI's pass. When Phase 15's corpus grows
   from live traffic, the erased run acquires real subjects and the gate's value rises
   accordingly.

2. **The identity-isolation gate covers cost terms and record builders, not the whole
   decision path.** `candidates/lowerBound.js`, `feasibility/predicates/f33.js` and
   `plan/planBuilder.js` read `lat`/`lon`. Under §23.7 that is the construction the section
   describes — a coordinate consumed to *produce* a fine cell, a geofence result, or a
   routing node — and not a violation, so widening the gate would fail correct code. What
   bounds the residual risk is the erasure gate, which measures the *effect* of erasure on a
   replayed cost rather than the presence of a name. The two are complementary and neither
   substitutes for the other. A future phase that wanted the static half to cover those
   modules would need the `@identifying-input` pragma applied at each site; the pragma exists
   and is tested, and there are no uses in the tree today.

3. **`Stop.label`, `Stop.lat`, `Stop.lon`, `Task.pickup` and `Task.drop` are still written by
   the legacy path.** The surrogate columns exist and the backfill fills them, but until
   Phase 15 the legacy dispatcher continues to write identifying values into `Stop` and
   `Task`. §23.7's schema rule binds the decision record and the snapshot, and that half is
   complete and enforced; the domain tables are compliant only once the drop happens. The
   `--redact` flag exists for that window and is not the default.

4. **The `User` model carries no region, fleet or tenant column, so ABAC scoping is inert in
   this deployment.** `override.outOfScope()` is implemented, tested in all four directions
   including tenant isolation, and wired into both authorisation paths through
   `policyFor(req)` — which reads `req.user.scope`, currently always `undefined`, which the
   module treats as unscoped. That is the current behaviour stated rather than assumed. When
   the columns land, `policyFor` is the single place that changes and every gated surface
   inherits it.

5. **The certificate worker's `sessions` provider is a stub in `server.js`.** It returns an
   empty list, because enumerating live sessions across a clustered deployment is a
   Socket.IO-adapter query the worker deliberately does not make itself — the socket that
   must be closed may be owned by a different process. The worker, the sweep and the
   termination handling are complete and tested against an injected provider; wiring a real
   fleet-wide session enumeration is a deployment integration, and the heartbeat-borne check
   in `robot.handler.js` covers every session this process owns in the meantime.

6. **Ed25519 command signing is implemented and not yet in use.** `offers.js` and
   `membership.js` still call `sign(envelope, key)` with the default HMAC scheme, because
   changing the scheme is a coordinated firmware rollout and a server that only spoke the new
   one would stop every un-updated agent accepting commands. Both schemes are supported per
   call; moving a fleet is a deployment sequence, not a code change.

7. **Certificate issuance is out of scope, by design.** The worker reports certificates
   approaching expiry and does not mint replacements: issuing device identities is the CA's
   job, and a fleet service able to issue its own would be one an attacker who reached it
   could issue identities from. The rotation lineage columns exist to record what the CA did.

8. **Five new Safety-class parameters are `PROVISIONAL`.** `security.attestation_max_age`,
   `security.position_plausibility_tolerance`, `security.energy_rate_tolerance`,
   `security.implausible_report_quarantine_threshold` and
   `security.certificate_revocation_recheck_interval` each name the data they await. They are
   blocked from production by Phase 15's V10 launch gate, which is the mechanism that exists
   for exactly this. `security.elevated_roles` and `security.second_approver_action_classes`
   are `DERIVED`: they are statements of the deployment's role model, not measurements.

---

## 14. Remaining Non-Blocking Issues

1. **Two-person approval is checked but not *collected*.** `X-Second-Approver` is a header
   the requester supplies; nothing verifies the named approver actually approved. §23.6 says
   "where configured a second approver" and §22.3's own workflow is the Config Service's
   `approvals` array, which does carry approver identities and timestamps. A real
   approval workflow — a pending-action table, an approve endpoint, a timeout — is a
   control-plane feature the specification does not describe, and inventing one would be this
   plan designing a mechanism. The distinctness check and the audit are in place; the
   collection is an operational integration.

2. **`persistentImplausibility` recommends quarantine; nothing issues it.** The counter, the
   threshold, the security event and the dashboard broadcast are all live. Actually
   quarantining is the `QUARANTINE` agent-scope command, which runs through the outbox and is
   gated on `ENGINE_ENABLED` like every other engine write. The recommendation is surfaced,
   counted and alertable in the meantime.

3. **The identity retention sweep needs `PRIVACY_IDENTITY_KEY` only for the backfill, not for
   erasure.** Tombstoning nulls ciphertext and needs no key, which is correct and slightly
   surprising: a deployment can erase without being able to read. Worth stating in the
   runbook Phase 15 writes.

4. **`AgentCertificate.agentId` is unindexed for the `agentId`-only lookup.** There is a
   composite `(agentId, status)` index, which serves every query this phase makes. A future
   "all certificates this device ever held" query would want the prefix, which the composite
   already provides.

5. **The `x-client-cert` header trust depends on the proxy stripping a client-supplied
   copy.** This is the same assumption `X-Forwarded-For` already rests on in
   `rateLimitHttp.js`, and it is stated in `robot.handler.js` beside the code. A deployment
   whose proxy does not strip it has a misconfiguration the application cannot detect — which
   is why `AGENT_MTLS_REQUIRED` exists and why `tlsPosture()` is logged at boot.

---

## 15. Readiness for Independent Verification

Phase 14 is complete against its checklist and ready for independent verification.

**Suggested verification path:**

1. **Run `npm run verify`.** Five gates and three lanes; expect 128 suites and 5,885 tests.
2. **Prove the two new gates can fail.** `tests/gates/checkIdentityIsolation.test.js` plants
   a violation in each scope and one outside both; `privacyErasure.test.js` plants a
   consumed identifying field and asserts the erased corpus diverges. Both are the phase's
   load-bearing claims.
3. **Check the absoluteness of class I in three places, independently.**
   `override.authoriseWaiver` refuses before reading the actor; the `OverrideAudit` CHECK
   refuses a granted row at the store; `evaluate.js` still has no bypass parameter. Any one
   of the three alone would be insufficient.
4. **Check the boundary claims of §12** — no service retired, no column dropped, no legacy
   event removed, `ENGINE_ENABLED` still false, `fairness/` still empty.
5. **Read §13 items 1, 2 and 3 first.** They are where this phase's claims are weaker than
   they look, and each is stated with the reason it was left that way rather than closed.

**Not verifiable in this phase, by construction:** the erasure gate's behaviour over a corpus
containing real subjects (Phase 15's corpus grows from live traffic), a coordinated firmware
rollout onto the asymmetric scheme, and the ABAC scoping's effect in a deployment that models
regions and tenants on `User`.
