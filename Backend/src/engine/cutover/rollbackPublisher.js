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
});

/** The identity this module publishes under, so the audit names the mechanism. */
const PUBLISHER = "cutover.guardrail-controller (automatic rollback, §22.4 item 4)";

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
 * @param {() => Promise<object|null>} deps.versionInForce resolves the payload of the
 *   currently pinned configuration version — `{ bindings, killSwitchState, regimes,
 *   spatial, shards }` — or `null` when nothing is published.
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

      const inForce = await dependencies.versionInForce();
      if (!inForce) {
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

module.exports = { REFUSAL, PUBLISHER, assertDisableOnly, bindingsWithRegionDisabled, create };
