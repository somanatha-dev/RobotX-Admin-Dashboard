"use strict";

/**
 * Making an automatic rollback *take effect* — **Tier 0 by consequence**.
 *
 * ── The defect this module exists to close (P15-R1) ────────────────────────
 * §22.4 item 4 is one sentence with three clauses:
 *
 * > 4. **Stage by shard**, monitored against pre-declared SLI guardrails, **with automatic
 * >    rollback**.
 *
 * `workers/cutover.worker.js` implements the first two and calls `deps.publish(action)` for
 * the third. `cutover/stage.js` says who is supposed to satisfy that call:
 *
 * > It writes nothing: it returns an authorisation, and the caller — **the cutover worker**
 * > or an operator's tooling — **publishes the configuration binding through the Config
 * > Service**.
 *
 * The production composition root supplied a `publish` that wrote a log line. Nothing else.
 * The consequences, measured against the shipped modules rather than argued:
 *
 *   - `cutover/enabled.js` resolves the shard half from the **published snapshot**, so the
 *     shard the controller had just "rolled back" was still live on the very next call;
 *   - `cutover/store.js` reads the guardrail declaration back from the audit stream and
 *     returns `null` once the latest cutover event is a rollback — so the next controller
 *     pass reported the shard as *live with no pre-declared guardrails* and **never
 *     assessed it again**.
 *
 * A shard that breached its guardrails was therefore left live and permanently unguarded,
 * by the mechanism whose entire purpose is to take it out of service. That is worse than
 * having no automatic rollback at all, because the audit stream records one as having
 * happened.
 *
 * ── Why an automated publish is permitted here, and how far it may go ──────
 * The composition root's comment argued that publishing is an approved, versioned operation
 * (§22.1 rule 4) and therefore not the controller's to perform. The parameter register
 * answers that directly, in `cutover.engine_enabled`'s own entry:
 *
 * > **STRUCTURAL rather than SAFETY on purpose**: §22.3 forbids any automated process from
 * > changing a Safety-class parameter, and **the automatic rollback of §22.4 item 4 must be
 * > able to set this false**. The asymmetry is enforced in code — `guardrails
 * > .assertOneDirectional` admits only DISABLE, and `stage.authoriseEnable` refuses an
 * > automated request outright — so the only automatic transition is the one that lowers
 * > risk.
 *
 * The change class was chosen for this. So the publish happens, it is `automated: true`, it
 * is versioned and audited like every other, and this module refuses to carry anything that
 * is not a disable:
 *
 *   - the action must be a `ROLLBACK`;
 *   - its binding must name `cutover.engine_enabled`, at `region` scope, with value
 *     **`false`** — a binding that sets anything else is refused by name rather than
 *     published and regretted;
 *   - every other binding, kill-switch state, regime, spatial declaration and shard
 *     definition of the version in force is **carried forward unchanged**, because a
 *     configuration version is a complete set and publishing a partial one would silently
 *     revert every other parameter to its register default.
 *
 * ── "The version in force" is the pinned one, and that was not what it read (P15-E2) ──
 * The sentence above was true of this module and false of the deployment. The composition
 * root supplied the *latest published* version, which is the version in force only while
 * nobody has published one without pinning it — and publishing without pinning is what
 * `config.controller.publishVersion` does for `{ pin: false }`, which is how a candidate is
 * put up for review. Measured live: with v10 pinned and v11 published-unpinned, one
 * automatic rollback published v12 **from v11** and pinned it, putting an unreviewed
 * configuration into force across the fleet as a side effect of disabling one shard.
 *
 * `versionInForceReader()` below is now the single implementation of that read, and it
 * reports the two version numbers as well as the payload so that the case the defect lived
 * in — the two disagreeing — is a refusal rather than something nothing could see.
 *
 * ── Publish and pin, or neither ────────────────────────────────────────────
 * `service.publish()` creates a version; `service.pinVersion()` is what makes a version the
 * one processes observe. Publishing without pinning would produce a durable record of a
 * rollback that no process acts on — the same shape as the defect above, one step further
 * in. Both happen here, and a failure in either is raised rather than swallowed, because
 * `cutover.worker` already states the rule this module has to honour: *"the whole value of
 * an automatic rollback is that its record and its effect agree."*
 *
 * ── Everything is injected ─────────────────────────────────────────────────
 * No `require` of the Config Service, no Prisma, no clock. `create()` takes the three
 * operations it needs, so this module is exercised in full without a database and the
 * composition root supplies the real ones.
 */

const enabled = require("./enabled");
const stage = require("./stage");
const guardrails = require("./guardrails");

/** @structural why a rollback publish was refused; a caller branches on these, not on prose */
const REFUSAL = Object.freeze({
  /** The action is not a `ROLLBACK`. Only a disable may be published automatically. */
  NOT_A_ROLLBACK: "NOT_A_ROLLBACK",
  /** The binding is absent, names another parameter, another scope, or another value. */
  BINDING_NOT_A_DISABLE: "BINDING_NOT_A_DISABLE",
  /** No configuration version is in force, so there is no complete set to carry forward. */
  NO_VERSION_IN_FORCE: "NO_VERSION_IN_FORCE",
  /**
   * The reading of "which version is in force" was not one this module can act on.
   *
   * Kept apart from `NO_VERSION_IN_FORCE`, which is a fact about the deployment. This one is
   * a fact about the *dependency*: a `versionInForce` that returned something of an
   * unrecognised shape is a composition defect, and P15-E2 is precisely what happens when
   * that goes unnoticed — the previous producer returned a bare payload of the wrong version
   * and nothing could tell.
   */
  VERSION_IN_FORCE_UNREADABLE: "VERSION_IN_FORCE_UNREADABLE",
  /**
   * A version has been published and not pinned, so the version in force is not the latest.
   *
   * `ConfigVersion` numbering is linear: any version this module publishes is `latest + 1`
   * and therefore **supersedes** the unpinned one. There is no third option — publishing the
   * in-force set reverts the candidate's content, and publishing the candidate's set promotes
   * a configuration nobody put in force — and both are decisions *about the candidate*, which
   * an automatic, one-directional control may not take. §22.3's rule for the second is
   * absolute: "No automated tuner may modify a Safety-class parameter."
   *
   * So it refuses and names the remedy. The shard stays live, which is the cost, and the
   * refusal says so — an operator resolves the candidate (pin it or supersede it) or takes
   * `docs/runbooks/rollback.md`'s Action A by hand, which is an operator publish and is not
   * subject to this rule.
   */
  SUPERSEDES_AN_UNPINNED_VERSION: "SUPERSEDES_AN_UNPINNED_VERSION",
});

/** The identity this module publishes under, so the audit names the mechanism. */
const PUBLISHER = "cutover.guardrail-controller (automatic rollback, §22.4 item 4)";

/**
 * The singleton row that holds which version is **in force**.
 *
 * `config/service.js` writes it in `pinVersion()` and reads it in `loadPinnedSnapshot()`;
 * it is the pointer every running process resolves its configuration through. Named here
 * because `versionInForce` below is the one dependency whose *identity* — not merely whose
 * shape — is part of this module's safety argument.
 *
 * @structural the config pin's singleton key, mirrored from `config/service.js`
 */
const ACTIVE_VERSION_ID = "singleton";

/**
 * The production reader for `versionInForce` — **the version in force, not the latest**.
 *
 * ── The defect this function exists to close (P15-E1/E2) ───────────────────
 * `create()` documents its dependency as *"the payload of the currently **pinned**
 * configuration version"*, this module's header says *"every other binding, kill-switch
 * state, regime, spatial declaration and shard definition of **the version in force** is
 * carried forward unchanged"*, and `docs/runbooks/rollback.md` §3 says the same. (That cited
 * §4, which is Rollback B — the redeploy — and says nothing about carrying a binding set
 * forward; corrected by the V-10 runbook trace, 2026-08-30.) The
 * composition root supplied something else:
 *
 *     const latest = await prisma.configVersion.findFirst({ orderBy: { version: "desc" } });
 *
 * That is the **highest-numbered published** version. It is the version in force only while
 * nobody has published one without pinning it — and publishing without pinning is a shipped,
 * supported operation: `config.controller.publishVersion` pins only `if (body.pin !== false)`,
 * which is what an operator does to put a candidate up for review.
 *
 * Measured against a real PostgreSQL instance driving the shipped modules: with v6 pinned
 * (`sla.assignment_deadline = 300`) and v7 published-but-unpinned (`= 900`), one automatic
 * rollback published v8 from **v7's** payload and pinned it. A control whose entire licence
 * to run without a human is that it may only ever disable one shard put an unreviewed
 * candidate configuration into force across the whole fleet.
 *
 * There is a second, sharper consequence, and it is structural rather than incidental.
 * `service.publish()` computes `safetyClassChanges` by diffing the candidate against the
 * **latest** version's values, and `checkSafetyApproval` refuses an `automated: true` publish
 * that changes any Safety-class parameter (finding S1 — §22.3's absolute rule, *"No
 * automated tuner may modify a Safety-class parameter"*). When the base set **is** the latest
 * version, that diff cannot contain anything the base did not already contain, so S1 is
 * structurally unable to fire. Reading the pinned version instead restores the check: a
 * divergence in a Safety-class parameter now shows up as a change, and the automatic publish
 * is refused rather than performed. That refusal is loud — `server.js` raises it and the
 * controller reports it every pass — which is the correct direction for a state in which an
 * unpinned Safety-class candidate and a breaching shard exist at the same time.
 *
 * Lives here rather than in the composition root because the previous arrangement is exactly
 * what a source-text test cannot pin: `server.js` held the only implementation, and its
 * disagreement with this module's stated contract was invisible to 7 001 tests. One
 * implementation, in the module that states the requirement, exercised against a real
 * database by `tools/verify/phase15VersionInForce.js`.
 *
 * Returns `null` when nothing is pinned, which `publishRollback` refuses by name
 * (`NO_VERSION_IN_FORCE`) — a shard cannot be live without a version in force, so that state
 * is not one a rollback is the repair for.
 *
 * ── Why it reports the latest version as well as the one in force ──────────
 * Not for information. `publishRollback` **requires** both and refuses without them, because
 * a rollback published while the two differ necessarily supersedes a version nobody put in
 * force — see `REFUSAL.SUPERSEDES_AN_UNPINNED_VERSION`. Returning the pair from one read is
 * what makes that rule unconditional: a check that ran only when the caller happened to
 * supply the second number would be a check with an off switch, and "omit the argument" is
 * how the previous pass's four findings were all reached.
 *
 * @param {{ prisma: object }} deps
 * @returns {Promise<{ version: number, latestVersion: number, payload: object }|null>}
 */
async function versionInForceReader(deps) {
  const { prisma } = deps || {};
  const pin = await prisma.configActiveVersion.findUnique({ where: { id: ACTIVE_VERSION_ID } });
  if (!pin) return null;
  const [row, latest] = await Promise.all([
    prisma.configVersion.findUnique({ where: { version: pin.version }, select: { payload: true } }),
    prisma.configVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } }),
  ]);
  if (!row || !row.payload || !latest) return null;
  return { version: pin.version, latestVersion: latest.version, payload: row.payload };
}

function refuse(code, message) {
  return { published: false, refusal: { code, message }, version: null, pinned: false };
}

/**
 * Is this action a disable of the cutover binding, and nothing else?
 *
 * Checked field by field rather than trusting `action.type`, because the whole safety
 * argument for automating this publish is that it can only ever lower risk. An assertion
 * about the *shape of the write* is what makes that argument checkable.
 *
 * @param {object} action a `stage.authoriseRollback()` action
 * @returns {{ ok: boolean, code: string|null, message: string|null }}
 */
function assertDisableOnly(action) {
  if (!action || action.type !== stage.ACTION.ROLLBACK) {
    return {
      ok: false,
      code: REFUSAL.NOT_A_ROLLBACK,
      message:
        `only a ${stage.ACTION.ROLLBACK} may be published without a human: §22.3 puts an automated ` +
        "enable outside what any change class permits, and `stage.authoriseEnable` refuses one outright.",
    };
  }

  const binding = action.binding || {};
  if (binding.name !== enabled.PARAMETER || binding.level !== "region" || binding.value !== false) {
    return {
      ok: false,
      code: REFUSAL.BINDING_NOT_A_DISABLE,
      message:
        `an automatic rollback publishes exactly \`${enabled.PARAMETER} = false\` at region scope. This ` +
        `action carries \`${binding.name} = ${JSON.stringify(binding.value)}\` at ` +
        `\`${binding.level}\` scope, which is not a disable and is refused rather than published.`,
    };
  }
  if (!binding.key) {
    return {
      ok: false,
      code: REFUSAL.BINDING_NOT_A_DISABLE,
      message: "the binding names no region, so it would be published at global scope and disable every shard",
    };
  }

  // The same assertion the worker makes on its way in, restated at the write rather than
  // only at the decision. `guardrails.assertOneDirectional` throws on anything but DISABLE.
  guardrails.assertOneDirectional("DISABLE");

  return { ok: true, code: null, message: null };
}

/**
 * Carry a version's declared bindings forward with one region's cutover binding disabled.
 *
 * A configuration version is a complete set (`service.safetyClassChanges`: *"a version is a
 * complete set, so a publish restates every binding it inherits"*). Publishing only the new
 * binding would revert every other parameter to its register default, which is a
 * fleet-wide change issued by a per-shard control.
 *
 * The region's own binding is **replaced**, not appended, so the published set holds one
 * binding per (level, key, name) and a resolver cannot be handed two answers.
 *
 * @param {object[]} bindings the version in force's declared bindings
 * @param {string} regionId
 * @returns {object[]}
 */
function bindingsWithRegionDisabled(bindings, regionId) {
  const key = String(regionId);
  const carried = (Array.isArray(bindings) ? bindings : []).filter(
    (binding) =>
      !(
        binding &&
        binding.name === enabled.PARAMETER &&
        binding.level === "region" &&
        String(binding.key) === key
      ),
  );
  carried.push({ level: "region", key, name: enabled.PARAMETER, value: false });
  return carried;
}

/**
 * Build the publisher the cutover worker's `publish` dependency expects.
 *
 * @param {object} deps
 * @param {() => Promise<{ version: number, latestVersion: number, payload: object }|null>}
 *   deps.versionInForce resolves the **pinned** configuration version — its number, the
 *   latest published version's number, and the pinned version's payload
 *   (`{ bindings, killSwitchState, regimes, spatial, shards }`) — or `null` when nothing is
 *   pinned. `versionInForceReader` above is the production implementation; a reading of any
 *   other shape is refused (`VERSION_IN_FORCE_UNREADABLE`) rather than treated as a payload.
 * @param {(request: object) => Promise<{ version: number }>} deps.publish `config/service.publish`
 * @param {(version: number, publishedBy: string) => Promise<*>} deps.pin `config/service.pinVersion`
 * @param {(event: string, detail: object) => void} [deps.record]
 * @returns {{ publishRollback: (action: object) => Promise<object> }}
 */
function create(deps) {
  const dependencies = deps || {};
  const record = typeof dependencies.record === "function" ? dependencies.record : () => {};

  return {
    /**
     * Publish and pin the reverted binding for one shard.
     *
     * @param {object} action a `stage.authoriseRollback()` action
     * @returns {Promise<{ published: boolean, version: number|null, pinned: boolean,
     *   refusal: object|null }>}
     */
    async publishRollback(action) {
      const admissible = assertDisableOnly(action);
      if (!admissible.ok) return refuse(admissible.code, admissible.message);

      const reading = await dependencies.versionInForce();
      if (!reading) {
        // There is no complete set to carry forward, and inventing one from register
        // defaults would publish a configuration nobody authored in order to disable one
        // shard. A shard cannot be live without a published version in the first place, so
        // this state means something is wrong that a rollback is not the repair for.
        return refuse(
          REFUSAL.NO_VERSION_IN_FORCE,
          "no configuration version is in force, so there is no complete binding set to carry forward. " +
            "A shard cannot be staged live without one; publishing register defaults to disable it would " +
            "change every other parameter at the same time.",
        );
      }

      /**
       * PHASE 15 remediation (P15-E2) — the reading is a version, not a bag of bindings.
       *
       * This dependency used to be documented as returning "the payload of the currently
       * pinned configuration version" and the composition root returned the payload of the
       * *latest* one. A payload alone cannot tell the two apart, which is why nothing did
       * for the whole life of this module. It now carries which version it is and which one
       * is latest, and an answer that does not is refused rather than read as a payload.
       */
      if (
        !Number.isInteger(reading.version) ||
        !Number.isInteger(reading.latestVersion) ||
        !reading.payload ||
        typeof reading.payload !== "object"
      ) {
        return refuse(
          REFUSAL.VERSION_IN_FORCE_UNREADABLE,
          "`versionInForce` must report which version is in force, which version is latest, and that " +
            "version's payload (`{ version, latestVersion, payload }`). It returned " +
            `${JSON.stringify(Object.keys(reading))}. A payload on its own cannot say which version it is, ` +
            "and a composition root that returned the wrong one was invisible for exactly that reason.",
        );
      }

      if (reading.version !== reading.latestVersion) {
        return refuse(
          REFUSAL.SUPERSEDES_AN_UNPINNED_VERSION,
          `configuration v${reading.version} is in force but v${reading.latestVersion} is the latest published, ` +
            `so it was published without being pinned. Any version this control publishes is ` +
            `v${reading.latestVersion + 1} and therefore supersedes it: carrying the in-force set forward ` +
            "reverts that candidate's content, and carrying the candidate's set forward puts a configuration " +
            "nobody approved into force — §22.3 forbids the second absolutely (\"No automated tuner may modify " +
            "a Safety-class parameter\") and neither is a decision an automatic, one-directional control may " +
            `take. Resolve v${reading.latestVersion} first — pin it or supersede it — or take Action A of ` +
            "docs/runbooks/rollback.md by hand, which is an operator publish and is not subject to this rule. " +
            "THE SHARD REMAINS LIVE UNTIL ONE OF THOSE HAPPENS.",
        );
      }

      const inForce = reading.payload;

      const published = await dependencies.publish({
        publishedBy: PUBLISHER,
        // §22.3's absolute rule, declared rather than implied. `cutover.engine_enabled` is
        // STRUCTURAL precisely so this is admissible; any Safety-class parameter caught up
        // in the carried-forward set is unchanged, so `safetyClassChanges` finds none and
        // the automated flag costs nothing. If that ever stops being true this publish
        // fails loudly, which is the behaviour to want.
        automated: true,
        bindings: bindingsWithRegionDisabled(inForce.bindings, action.binding.key),
        killSwitchState: inForce.killSwitchState,
        regimes: inForce.regimes,
        spatial: inForce.spatial,
        // Carried forward unchanged, like every other non-binding payload. A rollback that
        // dropped the delivery-domain declaration would silently widen nothing and narrow
        // everything — every subsequent geofence verdict would become INDETERMINATE — but it
        // would do so invisibly, and a rollback must change exactly the binding it names.
        deliveryDomain: inForce.deliveryDomain,
        shards: inForce.shards,
        note:
          `AUTOMATIC ROLLBACK — ${action.shardId} (region ${action.regionId}). ${action.reason} ` +
          `Consequence: ${action.consequence}`,
      });

      // Publishing creates a version; pinning is what makes processes observe it. A record
      // of a rollback that nothing acts on is the defect this module exists to remove, so
      // the two are not separable here.
      await dependencies.pin(published.version, PUBLISHER);

      record("cutover.rollback_published", {
        shardId: action.shardId,
        regionId: action.regionId,
        version: published.version,
        parameter: enabled.PARAMETER,
        value: false,
      });

      return { published: true, version: published.version, pinned: true, refusal: null };
    },
  };
}

module.exports = {
  REFUSAL,
  PUBLISHER,
  ACTIVE_VERSION_ID,
  versionInForceReader,
  assertDisableOnly,
  bindingsWithRegionDisabled,
  create,
};
