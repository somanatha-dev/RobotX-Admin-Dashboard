"use strict";

/**
 * The Config Service (§22).
 *
 * Five requirements from §22.1, and where each is met:
 *
 *   1. **No behavioural constant in code.** Every threshold, weight, timeout,
 *      exchange rate, policy flag, and model reference is configuration. The register
 *      lives in `register/*.json`; `tools/gates/checkParameterRegister.js` fails the
 *      build on any engine literal absent from it.
 *   2. **Every parameter has** name, type, unit, valid range, default, scope levels,
 *      owner, description, change class, and blast radius — checked at publish by
 *      `validators.checkEntryForm()`.
 *   3. **Configuration is versioned, immutable once published, and referenced by
 *      version in every decision record.** `publish()` writes a `ConfigVersion` whose
 *      row a database trigger refuses to update or delete, carrying a content
 *      signature over the canonical serialisation of its payload.
 *   4. **A round observes exactly one config version. Partial application is
 *      prohibited.** A snapshot is a value object: the round pins it (§9.6) and every
 *      resolution during that round reads it, never the live store.
 *   5. **Invalid configuration is rejected at publish time**, including
 *      cross-parameter consistency — `validators.validatePublish()`.
 *
 * And §22.1 rule 6: **derived parameters are computed here, never hand-entered**
 * (`derived.js`).
 *
 * ── Store roles (§3.3) ──────────────────────────────────────────────────────
 * Config is **DB-authoritative and cache-read**. Redis mirrors the active version
 * pointer (`config:active`) and the materialised resolved set (`config:v:{version}`)
 * so a resolution costs no query, but the cache tier holds no correctness-critical
 * sole copy: every read falls back to the database, and a flush of the entire cache
 * tier costs latency and nothing else. That is the mandatory constraint of §3.3 and a
 * Phase 15 release gate.
 *
 * ── What "DB-authoritative" costs, and where it was not paid ────────────────
 * §3.3's constraint is about a *flushed* cache — an empty mirror must cost latency and
 * nothing else — and `loadPinnedSnapshot()` satisfied that. It did not satisfy the
 * stronger and more important case: a **stale** mirror. The function read
 * `config:active` first and consulted `ConfigActiveVersion` only on a cache *miss*, so
 * a Redis pointer left behind by an earlier deployment — or by any of the several
 * harnesses that call `pinVersion(prisma, null, …)` and therefore move the database pin
 * without touching the mirror — silently won over the authoritative row. A process could
 * boot, and did boot, against a version the database did not consider active.
 *
 * "Cache-read" is therefore applied where a cache cannot be wrong and not where it can.
 * **Which version is active is read from the database, always**; it is one indexed
 * single-row lookup, on boot and on each propagation tick (§22.1 rule 4's pull, every
 * `cutover.guardrail_check_interval`), not on any decision path. The mirror is still
 * written on every pin, because it is what an operator and the cutover tooling read to
 * see the pointer without a query — but nothing resolves configuration *from* it.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { canonicalJson } = require("../determinism/ordering");
const { computeDerived } = require("./derived");
const { indexBindings, explain: explainAgainst, resolve: resolveAgainst, VALUE_SOURCE } = require("./resolver");
const killSwitches = require("./killSwitches");
const regimes = require("./regimes");
const { validatePublish, SEVERITY } = require("./validators");

const REGISTER_DIRECTORY = path.join(__dirname, "register");
const DIGEST_ALGORITHM = "sha256";
const JSON_EXTENSION = ".json";

/** @structural the first published version number */
const FIRST_VERSION = 1;

/** @param config.cache_ttl */
const DEFAULT_CACHE_TTL_SECONDS = 3600;

const ACTIVE_VERSION_KEY = "config:active";
const SINGLETON_PIN_ID = "singleton";

/** @structural the number of distinct people a Safety-class change requires (§22.3) */
const SAFETY_APPROVAL_QUORUM = 2;

const SAFETY_CHANGE_CLASS = "SAFETY";

/**
 * Raised when a publish is refused. Carries the findings so the caller — the REST
 * endpoint, a test, or an operator's tooling — can report *which* rule rejected it
 * rather than "invalid configuration".
 *
 * Defined in `errors.js` and re-exported here under the name callers already use.
 * It has to live below this module because the modules that detect a malformed
 * submission — `resolver`, `killSwitches`, `regimes` — are ones this module depends
 * on, and they raise the same type so that a caller's malformed input reaches the
 * REST boundary as the validation failure it is rather than as an unhandled fault.
 */
const { ConfigValidationError } = require("./errors");

let cachedRegister = null;

/**
 * Load the parameter register from `register/*.json`.
 *
 * The JSON files are the source of truth in the repository — the build gate reads the
 * same files — and `ParameterRegisterEntry` rows in the database mirror them for
 * query and for the resolution-explain endpoint.
 *
 * @param {{ reload?: boolean, directory?: string }} [options]
 * @returns {{ entries: Map<string, object>, files: string[], duplicates: string[] }}
 */
function loadRegister(options) {
  if (cachedRegister && !(options && options.reload) && !(options && options.directory)) {
    return cachedRegister;
  }

  const directory = (options && options.directory) || REGISTER_DIRECTORY;
  const entries = new Map();
  const duplicates = [];
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(JSON_EXTENSION))
    .sort();

  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed.parameters || [];
    for (const parameter of list) {
      if (!parameter || typeof parameter.name !== "string") continue;
      if (entries.has(parameter.name)) {
        duplicates.push(`${parameter.name} (redefined in ${file})`);
        continue;
      }
      entries.set(parameter.name, Object.freeze({ ...parameter, registerFile: file }));
    }
  }

  // Kill-switch states are behavioural configuration like any other value (§22.1
  // rule 1) and are registered in `register/killSwitches.json`, generated from the
  // §22.5 switch table in `killSwitches.js`. They live in a file rather than being
  // injected here so that the build gate — which reads only `register/*.json` — sees
  // the complete register; a gate with a partial view would fail a compliant module
  // that annotated one of them, and Phase 0's gates are one-sided the other way.
  const missingSwitches = killSwitches.KILL_SWITCH_NAMES.filter((name) => !entries.has(`killswitch.${name}`));
  if (missingSwitches.length > 0) {
    duplicates.push(
      `killSwitches.json is missing an entry for: ${missingSwitches.join(", ")} (§22.5, §22.1 rule 1)`,
    );
  }

  const register = Object.freeze({ entries, files, duplicates });
  if (!(options && options.directory)) cachedRegister = register;
  return register;
}

/**
 * The register's content digest, so a snapshot records which register it was built
 * against and a replay can detect a register that has moved underneath it.
 *
 * @param {Map<string, object>} entries
 * @returns {string}
 */
function registerDigest(entries) {
  const material = [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, entry]) => ({
      name,
      type: entry.type,
      unit: entry.unit,
      default: entry.default === undefined ? null : entry.default,
      range: entry.range === undefined ? null : entry.range,
      changeClass: entry.changeClass,
      calibrationStatus: entry.calibrationStatus,
    }));
  return crypto.createHash(DIGEST_ALGORITHM).update(canonicalJson(material)).digest("hex");
}

/**
 * The effective value of every parameter at global scope, before derivation.
 *
 * @param {Map<string, object>} entries
 * @param {Map<string, object>} bindingIndex
 * @returns {Map<string, *>}
 */
function baseValues(entries, bindingIndex) {
  const values = new Map();
  const partial = { entries, bindings: bindingIndex, version: null };
  for (const name of entries.keys()) {
    values.set(name, resolveAgainst(partial, name));
  }
  return values;
}

/**
 * Build an immutable configuration snapshot: the artefact a round pins and every
 * resolution reads.
 *
 * @param {object} [options]
 * @param {Array<{ level?: string, key?: string, name: string, value: * }>} [options.bindings]
 * @param {number|null} [options.version]
 * @param {string|null} [options.publishedAt]
 * @param {Record<string, boolean>} [options.killSwitchState]
 * @param {object[]} [options.regimes]
 * @param {object} [options.spatial]
 * @param {object} [options.deliveryDomain] S-3 row 29 — the authoritative delivery-domain
 *   declaration (RD-2026-09-14-01 D7), a distinct input from the cell assignments
 * @param {object[]} [options.shards] PHASE 13 — the §3.5 shard definitions this publish
 *   declares, validated per shard by V4 against that region's measured mission rate
 * @param {Map<string, object>} [options.entries] register override, used by tests
 * @returns {object} snapshot
 */
function buildSnapshot(options) {
  const settings = options || {};
  const entries = settings.entries || loadRegister().entries;

  const activeRegime = regimes.activeRegime(settings.regimes || []);
  const declaredBindings = [...(settings.bindings || [])];
  const effectiveBindings = [...declaredBindings, ...regimes.bindingsFor(activeRegime || {})];
  const bindingIndex = indexBindings(effectiveBindings);

  const values = baseValues(entries, bindingIndex);
  const derivation = computeDerived(entries, values);
  for (const [name, value] of derivation.values.entries()) values.set(name, value);

  const switchState = killSwitches.normaliseState(settings.killSwitchState);
  for (const [name, thrown] of Object.entries(switchState)) values.set(`killswitch.${name}`, thrown);

  const snapshot = {
    version: settings.version === undefined ? null : settings.version,
    publishedAt: settings.publishedAt || null,
    entries,
    bindings: bindingIndex,
    declaredBindings,
    derivedValues: derivation.values,
    derivationProblems: derivation.problems,
    derivationEvidence: derivation.evidence,
    values,
    killSwitchState: switchState,
    killSwitchClassification: killSwitches.classify(switchState),
    regimes: settings.regimes || [],
    activeRegime: activeRegime ? activeRegime.name : null,
    spatial: settings.spatial || null,
    // **S-3 row 29 — the authoritative delivery-domain declaration (RD-2026-09-14-01 D7).**
    //
    // A sibling of `spatial`, deliberately, and not a member of it. `spatial` is the
    // CellAssignment input: cell → zone / site / region attribution, which §8.3's `λ_zone`
    // and the pricing hierarchy read. This is a different fact from a different owner —
    // the published geometry that says what ground RobotX commits to serve. Folding it
    // into `spatial` would let an index publication silently redefine the delivery domain,
    // which is the conflation D1 exists to end.
    //
    // It travels with the version for the same reason the spatial maps do: the geofence
    // verdict is taken against *the declaration in force at intake* and pinned, so a
    // replay must be able to reconstruct which geometry that was without consulting
    // another store.
    deliveryDomain: settings.deliveryDomain || null,
    // PHASE 13 — §3.5's shard definitions travel with the version for the same reason the
    // spatial maps do: the sizing inequality is evaluated per region, so the definitions
    // are an input to publish-time validation rather than a separate control-plane object
    // that could be changed without re-running V4.
    shards: settings.shards || null,
    registerDigest: registerDigest(entries),
  };

  snapshot.explain = (name, context, resolveOptions) => explainAgainst(snapshot, name, context, resolveOptions);
  snapshot.resolve = (name, context, resolveOptions) => resolveAgainst(snapshot, name, context, resolveOptions);

  return snapshot;
}

/**
 * The defaults-only snapshot: the register with no bindings and every kill switch
 * thrown (§1.8 rule 3).
 *
 * This is what the legacy compatibility shims read, and what boot falls back to while
 * `ENGINE_ENABLED` is false. It requires no database and no cache, which is why a
 * legacy path that has always run from compile-time constants can be moved onto the
 * register without acquiring a startup dependency it did not have before.
 *
 * @returns {object}
 */
function defaultSnapshot() {
  return buildSnapshot();
}

/**
 * Validate a candidate configuration without publishing it.
 *
 * @param {object} [options] as `buildSnapshot`, plus `enforceLaunchGate`
 * @returns {{ snapshot: object, result: object }}
 */
function validateCandidate(options) {
  const snapshot = buildSnapshot(options);
  const result = validatePublish({
    entries: snapshot.entries,
    bindings: snapshot.declaredBindings,
    values: snapshot.values,
    derivedValues: snapshot.derivedValues,
    derivationEvidence: snapshot.derivationEvidence,
    spatial: snapshot.spatial,
    deliveryDomain: snapshot.deliveryDomain,
    shards: snapshot.shards,
    enforceLaunchGate: Boolean(options && options.enforceLaunchGate),
  });
  return { snapshot, result };
}

/**
 * Which Safety-class parameters does this publish actually *change* (§22.3)?
 *
 * A version is a complete set, so a publish restates every binding it inherits.
 * Treating a restated identical value as a change would make every routine Tuned
 * publish a Safety-class event, and a process that demands safety review for a
 * no-op change teaches people to click through safety reviews. The comparison is
 * therefore against the currently published values, over the *effective* value of
 * every Safety-class parameter — so removing a binding and reverting to the default
 * counts as a change too, which restating-bindings-only would have missed.
 *
 * With no previous version, every Safety-class parameter that has a value is a
 * change: the first publish establishes them all.
 *
 * @param {Map<string, object>} entries
 * @param {Map<string, *>|object} values the candidate's effective values
 * @param {object|null} [previousValues] the pinned version's effective values
 * @param {object[]} [declaredRegimes]
 * @returns {string[]}
 */
function safetyClassChanges(entries, values, previousValues, declaredRegimes) {
  const names = new Set();
  const read = (source, name) => (source instanceof Map ? source.get(name) : source ? source[name] : undefined);
  const same = (a, b) => canonicalJson({ v: a === undefined ? null : a }) === canonicalJson({ v: b === undefined ? null : b });

  for (const [name, entry] of entries.entries()) {
    if (entry.changeClass !== SAFETY_CHANGE_CLASS) continue;
    const next = read(values, name);
    if (next === null || next === undefined) continue;
    if (previousValues && same(next, read(previousValues, name))) continue;
    names.add(name);
  }

  for (const regime of declaredRegimes || []) {
    for (const name of regimes.safetyClassDeltas(regime, entries)) names.add(`${name} (regime ${regime.name})`);
  }
  return [...names].sort();
}

/**
 * Enforce §22.3's approval process for Safety-class changes.
 *
 * Two rules, both absolute:
 *   - **No automated tuner may modify a Safety-class parameter.** An optimiser
 *     permitted to reduce its own safety margins in pursuit of throughput will do
 *     exactly that, and it will be locally correct every time.
 *   - **Two-person approval.** Two *distinct* identities, counting the publisher as
 *     one of them.
 *
 * @param {{ publishedBy: string, approvals?: Array<{ approverId: string, approvedAt?: string }>,
 *           automated?: boolean }} request
 * @param {string[]} changes Safety-class parameters this publish touches
 * @returns {object[]} findings
 */
function checkSafetyApproval(request, changes) {
  if (changes.length === 0) return [];
  const findings = [];

  if (request.automated) {
    findings.push({
      id: "S1",
      severity: SEVERITY.BLOCKING,
      rule: "§22.3",
      message:
        `this publish is marked automated and changes Safety-class parameter(s) ${changes.join(", ")}. ` +
        "No automated tuner may modify a Safety-class parameter. This is an absolute rule: an " +
        "optimiser permitted to reduce its own safety margins in pursuit of throughput will do " +
        "exactly that, and it will be locally correct every time.",
    });
  }

  const identities = new Set();
  if (request.publishedBy) identities.add(String(request.publishedBy));
  for (const approval of request.approvals || []) {
    if (approval && approval.approverId) identities.add(String(approval.approverId));
  }

  if (identities.size < SAFETY_APPROVAL_QUORUM) {
    findings.push({
      id: "S2",
      severity: SEVERITY.BLOCKING,
      rule: "§22.3",
      message:
        `Safety-class change to ${changes.join(", ")} carries ${identities.size} distinct ` +
        `approver identities; two-person approval requires ${SAFETY_APPROVAL_QUORUM} (§22.3).`,
    });
  }

  for (const approval of request.approvals || []) {
    if (!approval || !approval.approverId || !approval.approvedAt) {
      findings.push({
        id: "S3",
        severity: SEVERITY.BLOCKING,
        rule: "§22.3",
        message: "every approval records an approver identity and the time it was given (§22.3 audit).",
      });
      break;
    }
  }

  return findings;
}

/**
 * The payload a published version carries: everything a replay needs to reconstruct
 * the same resolution, without consulting any other store.
 *
 * @param {object} snapshot
 * @returns {object}
 */
function publishPayload(snapshot) {
  return {
    registerDigest: snapshot.registerDigest,
    bindings: snapshot.declaredBindings,
    derivedValues: Object.fromEntries(snapshot.derivedValues.entries()),
    values: Object.fromEntries(snapshot.values.entries()),
    killSwitchState: snapshot.killSwitchState,
    killSwitchStatus: snapshot.killSwitchClassification.status,
    regimes: snapshot.regimes,
    activeRegime: snapshot.activeRegime,
    spatial: snapshot.spatial,
    deliveryDomain: snapshot.deliveryDomain,
    shards: snapshot.shards,
  };
}

/**
 * Publish a new immutable configuration version.
 *
 * @param {object} prisma
 * @param {object} request
 * @param {string} request.publishedBy
 * @param {Array<object>} [request.bindings]
 * @param {Array<object>} [request.approvals]
 * @param {Record<string, boolean>} [request.killSwitchState]
 * @param {object[]} [request.regimes]
 * @param {object} [request.spatial]
 * @param {object} [request.deliveryDomain] S-3 row 29 — the authoritative delivery-domain declaration
 * @param {object[]} [request.shards] PHASE 13 — §3.5 shard definitions
 * @param {string} [request.note]
 * @param {boolean} [request.automated]
 * @param {boolean} [request.enforceLaunchGate] set for a production publish, where
 *   §22.4's Safety-class calibration gate is blocking rather than reported
 * @returns {Promise<object>} the published version record
 * @throws {ConfigValidationError}
 */
async function publish(prisma, request) {
  const { snapshot, result } = validateCandidate(request);

  for (const regime of request.regimes || []) {
    for (const problem of regimes.validateDeclaration(regime, snapshot.entries)) {
      result.findings.push({ id: "R1", severity: SEVERITY.BLOCKING, rule: "§22.2", message: problem });
      result.blocking.push({ id: "R1", severity: SEVERITY.BLOCKING, rule: "§22.2", message: problem });
    }
  }

  const latest = await prisma.configVersion.findFirst({
    orderBy: { version: "desc" },
    select: { version: true, payload: true },
  });
  const previousValues = latest && latest.payload ? latest.payload.values || null : null;

  const changes = safetyClassChanges(snapshot.entries, snapshot.values, previousValues, request.regimes);
  const approvalFindings = checkSafetyApproval(request, changes);
  result.findings.push(...approvalFindings);
  result.blocking.push(...approvalFindings);

  if (result.blocking.length > 0) {
    throw new ConfigValidationError(
      `configuration rejected at publish time: ${result.blocking.length} blocking finding(s). ` +
        "Invalid configuration is rejected at publish, not discovered at decision time (§22.1 rule 5).",
      result.findings,
    );
  }

  const version = latest ? latest.version + FIRST_VERSION : FIRST_VERSION;

  const payload = publishPayload(snapshot);
  const signature = crypto.createHash(DIGEST_ALGORITHM).update(canonicalJson(payload)).digest("hex");

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.configVersion.create({
      data: {
        version,
        publishedBy: String(request.publishedBy),
        signature,
        payload,
        note: request.note || null,
        approvals: request.approvals || [],
        safetyClassChanges: changes,
        launchGateFindings: result.launchGate,
      },
    });

    if (snapshot.declaredBindings.length > 0) {
      await tx.configScopeBinding.createMany({
        data: snapshot.declaredBindings.map((binding) => ({
          configVersionId: row.id,
          scopeLevel: binding.level || "global",
          scopeKey: binding.key === undefined || binding.key === null ? "" : String(binding.key),
          parameterName: binding.name,
          value: { value: binding.value },
        })),
      });
    }

    return row;
  });

  return { ...created, findings: result.findings, launchGate: result.launchGate, snapshot };
}

/**
 * Pin a published version as the active one.
 *
 * The pointer **is** the database row; `config:active` is a mirror of it and not a second
 * place the pointer lives. `loadPinnedSnapshot()` reads the row, so a `kv` of `null` here
 * — which is how every verification harness on the tree calls this — leaves the mirror
 * stale without leaving the deployment wrong. A round loads the pinned version once and
 * observes exactly that version for its whole duration (§22.1 rule 4): configuration
 * change propagation is pull-with-pin, never a push that could land mid-round.
 *
 * @param {object} prisma
 * @param {object|null} kv
 * @param {number} version
 * @param {string} pinnedBy
 * @returns {Promise<object>}
 */
async function pinVersion(prisma, kv, version, pinnedBy) {
  const target = await prisma.configVersion.findUnique({ where: { version } });
  if (!target) throw new Error(`config version ${version} does not exist and cannot be pinned`);

  const pin = await prisma.configActiveVersion.upsert({
    where: { id: SINGLETON_PIN_ID },
    create: { id: SINGLETON_PIN_ID, version, pinnedBy: String(pinnedBy) },
    update: { version, pinnedBy: String(pinnedBy), pinnedAt: new Date() },
  });

  if (kv) {
    try {
      await kv.set(ACTIVE_VERSION_KEY, String(version));
      await kv.set(`config:v:${version}`, JSON.stringify(target.payload), { ex: DEFAULT_CACHE_TTL_SECONDS });
    } catch {
      // Cache-fill failure is not an error: config is DB-authoritative and the cache
      // tier holds no correctness-critical sole copy (§3.3).
    }
  }

  return pin;
}

/**
 * Load the pinned configuration version.
 *
 * DB-authoritative. **Which version is active is decided by `ConfigActiveVersion`, the
 * row `pinVersion()` writes, and by nothing else.** A cache miss, a stale mirror, or a
 * flushed Redis costs one query — never a wrong answer.
 *
 * ── Why the `config:active` mirror is not read here ─────────────────────────
 * It used to be, cache-first, and that was the defect. The mirror is a *derived copy of
 * a pointer*, and a copy of a pointer is the one thing a cache cannot hold safely: it
 * does not merely go missing, it goes **wrong**, and a wrong answer here is a process
 * that resolves every parameter against a version nobody put in force. The ways it goes
 * wrong are ordinary rather than exotic —
 *
 *   · `pinVersion(prisma, null, …)` moves the database pin with no kv to update, which
 *     is what `tools/verify/v1CorePath.js`, `v10RollbackRunbook.js` and
 *     `phase15VersionInForce.js` all do;
 *   · a shared or long-lived Redis outlives the database it was filled from;
 *   · the cache-fill in `pinVersion` is deliberately best-effort and swallows its error.
 *
 * — and in each of them the database is right and the mirror is stale. Reading the
 * authoritative row costs one indexed single-row lookup on a path that runs at boot and
 * once per propagation tick, never inside a round: §22.1 rule 4 pins the snapshot for the
 * round's duration precisely so that no decision re-reads this.
 *
 * The version-keyed payload (`config:v:{version}`) is a different case — a published
 * version is immutable (§22.1 rule 3), so that key cannot be stale — but it is not read
 * here either, because the snapshot also carries `signature` and `publishedAt`, which
 * live on the `ConfigVersion` row and not in the cached payload. Serving those from a
 * cache that does not hold them would be the same substitution one field further down.
 *
 * @param {{ prisma: object, kv?: object|null, version?: number }} options
 * @returns {Promise<object|null>} snapshot, or null when nothing is published yet
 */
async function loadPinnedSnapshot(options) {
  const { prisma } = options;
  let version = options.version;

  if (version === undefined || version === null) {
    const pin = await prisma.configActiveVersion.findUnique({ where: { id: SINGLETON_PIN_ID } });
    if (!pin) return null;
    version = pin.version;
  }

  const row = await prisma.configVersion.findUnique({ where: { version } });
  if (!row) return null;

  const payload = row.payload || {};
  const snapshot = buildSnapshot({
    bindings: payload.bindings || [],
    version: row.version,
    publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
    killSwitchState: payload.killSwitchState,
    regimes: payload.regimes || [],
    spatial: payload.spatial || null,
    deliveryDomain: payload.deliveryDomain || null,
    shards: payload.shards || null,
  });

  snapshot.signature = row.signature;
  snapshot.registerDigestAtPublish = payload.registerDigest || null;
  return snapshot;
}

/**
 * Mirror the register into `ParameterRegisterEntry` rows. Idempotent.
 *
 * @param {object} prisma
 * @param {{ entries?: Map<string, object> }} [options]
 * @returns {Promise<{ seeded: number }>}
 */
async function seedRegister(prisma, options) {
  const entries = (options && options.entries) || loadRegister().entries;
  let seeded = 0;

  for (const entry of entries.values()) {
    const data = {
      name: entry.name,
      type: entry.type,
      unit: entry.unit,
      defaultValue: entry.default === undefined ? null : { value: entry.default },
      range: entry.range === undefined || entry.range === null ? null : entry.range,
      scopes: entry.scopes || [],
      specScope: entry.specScope || null,
      changeClass: entry.changeClass,
      owner: entry.owner,
      blastRadius: entry.blastRadius || null,
      calibrationStatus: entry.calibrationStatus,
      awaits: entry.awaits || null,
      section: entry.section || null,
      description: entry.description || null,
      derivation: entry.derivation || null,
      registerFile: entry.registerFile || null,
    };
    await prisma.parameterRegisterEntry.upsert({ where: { name: entry.name }, create: data, update: data });
    seeded += 1;
  }

  return { seeded };
}

/**
 * Load the configuration this process will resolve against.
 *
 * The fallback policy is deliberately asymmetric, and turns on the master switch:
 *
 *   - **`ENGINE_ENABLED` false** — the engine is inert and only the legacy
 *     compatibility shims read the register. A missing or unreachable published
 *     version degrades to the register defaults with a warning, because the legacy
 *     dispatcher has always run from compile-time constants and Phase 1 must not give
 *     it a new startup dependency it can fail on.
 *   - **`ENGINE_ENABLED` true** — the engine claims to be running, and config is
 *     DB-authoritative (§3.3). A process that cannot load its pinned version does not
 *     silently invent one: it fails to start, because a round that observes defaults
 *     while believing it observes version N is exactly the partial application §22.1
 *     rule 4 prohibits.
 *
 * @param {{ prisma?: object, kv?: object|null, logger?: object, engineEnabled?: boolean }} options
 * @returns {Promise<object>} the snapshot this process resolves against
 */
async function bootstrap(options) {
  const settings = options || {};
  const logger = settings.logger;
  const engineEnabled =
    settings.engineEnabled === undefined
      ? String(process.env.ENGINE_ENABLED || "").toLowerCase() === "true"
      : Boolean(settings.engineEnabled);

  const register = loadRegister();
  if (register.duplicates.length > 0) {
    throw new Error(
      `parameter register has duplicate entries: ${register.duplicates.join(", ")}. ` +
        "A parameter defined twice has two defaults and no single owner (§22.1 rule 2).",
    );
  }

  let pinned = null;
  let failure = null;
  if (settings.prisma) {
    try {
      pinned = await loadPinnedSnapshot({ prisma: settings.prisma, kv: settings.kv || null });
    } catch (error) {
      failure = error;
    }
  }

  if (pinned) {
    logger?.info?.(`Config Service: pinned version ${pinned.version} loaded`, {
      registerEntries: register.entries.size,
      activeRegime: pinned.activeRegime,
      killSwitches: pinned.killSwitchClassification.status,
    });
    return pinned;
  }

  if (engineEnabled) {
    throw new Error(
      "ENGINE_ENABLED is true but no pinned configuration version could be loaded" +
        `${failure ? `: ${failure.message}` : ""}. Config is DB-authoritative (§3.3) and a round ` +
        "observes exactly one published version (§22.1 rule 4); starting on defaults would be the " +
        "partial application that rule prohibits.",
    );
  }

  const snapshot = defaultSnapshot();
  logger?.info?.("Config Service: running on register defaults (ENGINE_ENABLED=false, nothing published)", {
    registerEntries: register.entries.size,
    derivationProblems: snapshot.derivationProblems.length,
  });
  return snapshot;
}

/**
 * List published versions, newest first.
 *
 * @param {object} prisma
 * @param {{ take?: number }} [options]
 * @returns {Promise<object[]>}
 */
async function listVersions(prisma, options) {
  const take = options && options.take;
  return prisma.configVersion.findMany({
    orderBy: { version: "desc" },
    ...(take ? { take } : {}),
    select: {
      version: true,
      publishedAt: true,
      publishedBy: true,
      signature: true,
      note: true,
      safetyClassChanges: true,
    },
  });
}

module.exports = {
  ACTIVE_VERSION_KEY,
  SINGLETON_PIN_ID,
  DEFAULT_CACHE_TTL_SECONDS,
  SAFETY_APPROVAL_QUORUM,
  VALUE_SOURCE,
  ConfigValidationError,
  loadRegister,
  registerDigest,
  buildSnapshot,
  defaultSnapshot,
  validateCandidate,
  safetyClassChanges,
  checkSafetyApproval,
  publishPayload,
  publish,
  pinVersion,
  loadPinnedSnapshot,
  bootstrap,
  seedRegister,
  listVersions,
};
