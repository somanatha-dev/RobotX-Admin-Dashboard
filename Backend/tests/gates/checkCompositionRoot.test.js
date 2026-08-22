"use strict";

/**
 * Gates lane — the composition-root gate.
 *
 * Every test in this lane plants a deliberate violation and asserts the gate catches it. A
 * gate that cannot fail is not a gate.
 *
 * ── What this gate found, and what changed when half of it was fixed ───────
 * It first failed on the real tree for **four** workers: `coordinator`, `outbox`,
 * `reconciler` and `timer` are all `LEADER_ONLY` and all Tier 0, and no module under `src/`
 * or `server.js` required any of them. The Phase 15 remediation (D-5) added
 * `workers/leaderWorkers.js` — the shard supervisor's promotion hook — and started two of
 * them. Wiring the outbox closed a live dangling path: `shard/membership.js:migrate()` had
 * been enqueuing `SHARD_MIGRATE` rows inside the handoff transaction that nothing ever
 * delivered.
 *
 * The remaining two are **not** wiring gaps, and the gate had to learn to say so. Reporting
 * "the routing engine B1 has not selected" and "nobody has wired this module" as the same
 * finding invited the wrong repair — require the module, turn the gate green, start a worker
 * that runs and decides wrongly. So `LEADER_ONLY_NOT_COMPOSABLE` exists, it carries the
 * blocker and its owner, and it keeps the gate red for a reason no commit here can remove.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const gate = require("../../tools/gates/checkCompositionRoot");
const registry = require("../../src/workers/registry");
const lifecycle = require("../../src/workers/leaderWorkers");
const gates = require("../../src/engine/cutover/gates");

/**
 * A throwaway backend root: a `server.js` with the given body and an empty `src/`.
 *
 * The gate reads the registry and the leadership lifecycle from the real modules — both are
 * the specification of what *should* be wired, and a fixture copy would test the fixture.
 */
function treeWith(serverBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robotx-composition-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "server.js"), serverBody, "utf8");
  return root;
}

/**
 * A `server.js` that wires every worker the registry expects wired.
 *
 * The requires are written with the `./src/workers/…` prefix the real composition root uses,
 * and the gate resolves them against the fixture root — so the fixture exercises the gate's
 * real resolution path rather than a substring match.
 */
function wellWiredServer() {
  const lines = [];
  for (const worker of registry.WORKERS) {
    if (worker.readiness === registry.READINESS.DEFERRED) continue;
    const binding = worker.id.replace(/_(.)/g, (_, c) => c.toUpperCase());
    lines.push(`const ${binding} = require("./src/${worker.module}");`);
    // LEADER_ONLY workers need only be reachable; requiring them satisfies that half.
    if (worker.readiness === registry.READINESS.SCHEDULED) lines.push(`${binding}.start({}, {});`);
  }
  return lines.join("\n");
}

/**
 * The worker files the fixture's requires must resolve to.
 *
 * The gate resolves rather than string-matches, so the fixture tree has to contain the
 * files. This is the point of the change: `require("./coordinator.worker")` from a sibling in
 * `src/workers/` carries no `workers/` segment, and the substring check this replaced missed
 * a real reference while claiming to measure one.
 */
function withWorkerFiles(root) {
  fs.mkdirSync(path.join(root, "src", "workers"), { recursive: true });
  for (const worker of registry.WORKERS) {
    fs.writeFileSync(path.join(root, "src", `${worker.module}.js`), "module.exports = { start: () => ({ stop() {} }) };\n", "utf8");
  }
  return root;
}

/** The workers `leaderWorkers.js` declares it cannot compose, in registry order. */
const DECLARED_UNCOMPOSABLE = registry
  .scheduledOnLeadership()
  .filter((id) => Boolean(lifecycle.UNCOMPOSABLE[id]));

describe("THE GATE PASSES a correctly wired composition root", () => {
  test("every SCHEDULED worker required and started; the only findings are the declared blockers", () => {
    const result = gate.checkCompositionRoot({ root: withWorkerFiles(treeWith(wellWiredServer())) });

    // A well-wired tree produces no *wiring* violation at all.
    const wiring = result.violations.filter((v) => v.kind !== gate.FINDING.LEADER_ONLY_NOT_COMPOSABLE);
    expect(wiring).toEqual([]);

    // What remains is exactly the set the lifecycle declares it cannot build, which is a
    // property of this repository's dependencies and not of the fixture's wiring.
    expect(result.violations.map((v) => v.worker).sort()).toEqual([...DECLARED_UNCOMPOSABLE].sort());
  });
});

describe("THE GATE FAILS on the violations it exists to catch", () => {
  test("PLANTED — a SCHEDULED worker the composition root never requires", () => {
    const server = wellWiredServer()
      .split("\n")
      .filter((line) => !line.includes("workers/invariant.worker"))
      .join("\n");
    const result = gate.checkCompositionRoot({ root: withWorkerFiles(treeWith(server)) });

    const violation = result.violations.find((v) => v.worker === "invariant");
    expect(violation).toBeDefined();
    expect(violation.kind).toBe(gate.FINDING.SCHEDULED_NOT_REQUIRED);
    expect(result.ok).toBe(false);
  });

  test("PLANTED — a SCHEDULED worker required but never started", () => {
    // The failure that looks most like success in a diff: the require is right there.
    const server = wellWiredServer()
      .split("\n")
      .filter((line) => !/^tierB\.start\(/.test(line))
      .join("\n");
    const result = gate.checkCompositionRoot({ root: withWorkerFiles(treeWith(server)) });

    const violation = result.violations.find((v) => v.worker === "tier_b");
    expect(violation).toBeDefined();
    expect(violation.kind).toBe(gate.FINDING.SCHEDULED_NOT_STARTED);
  });

  test("PLANTED — a LEADER_ONLY worker nothing in production names", () => {
    const server = wellWiredServer()
      .split("\n")
      .filter((line) => !line.includes("workers/outbox.worker"))
      .join("\n");
    const result = gate.checkCompositionRoot({ root: withWorkerFiles(treeWith(server)) });

    const violation = result.violations.find((v) => v.worker === "outbox");
    expect(violation).toBeDefined();
    expect(violation.kind).toBe(gate.FINDING.LEADER_ONLY_UNREACHABLE);
    // The tier is carried into the finding, because a Tier 0 worker going missing and a
    // Tier 1 one going missing are not the same incident.
    expect(violation.tier).toBe(0);
  });

  test("PLANTED — a DEFERRED worker the composition root starts anyway", () => {
    const server = `${wellWiredServer()}\nconst shadow = require("./src/workers/shadow.worker");\nshadow.start({}, {});`;
    const result = gate.checkCompositionRoot({ root: withWorkerFiles(treeWith(server)) });

    const violation = result.violations.find((v) => v.worker === "shadow");
    expect(violation).toBeDefined();
    expect(violation.kind).toBe(gate.FINDING.DEFERRED_BUT_STARTED);
  });

  test("a LEADER_ONLY worker reachable from src/ but not server.js is not a reachability finding", () => {
    // §19.3 admits one writer per shard, so these start on leadership acquisition rather
    // than at boot. Reachability from production is the right check; "started in server.js"
    // would be the wrong one and would push the wiring into the wrong place. This is how the
    // real tree is arranged: `server.js` requires `leaderWorkers`, which requires the four.
    const server = wellWiredServer()
      .split("\n")
      .filter((line) => !line.includes("workers/reconciler.worker"))
      .join("\n");
    const root = withWorkerFiles(treeWith(server));
    fs.writeFileSync(
      path.join(root, "src", "leadership.js"),
      'const reconciler = require("./workers/reconciler.worker");\nmodule.exports = { reconciler };',
      "utf8",
    );

    const result = gate.checkCompositionRoot({ root });
    expect(result.violations.find((v) => v.worker === "reconciler")).toBeUndefined();
  });

  test("REGRESSION — a relative require from a sibling resolves; the old substring check missed it", () => {
    // `require("./coordinator.worker")` contains no `workers/` segment. The gate that
    // matched the registry's module tail as a substring reported the worker unreachable
    // while a production module was requiring it three lines away.
    const server = wellWiredServer()
      .split("\n")
      .filter((line) => !line.includes("workers/outbox.worker"))
      .join("\n");
    const root = withWorkerFiles(treeWith(server));
    fs.writeFileSync(
      path.join(root, "src", "workers", "lifecycleHook.js"),
      'const outbox = require("./outbox.worker");\nmodule.exports = { outbox };',
      "utf8",
    );

    const result = gate.checkCompositionRoot({ root });
    expect(result.violations.find((v) => v.worker === "outbox")).toBeUndefined();
  });
});

describe("it is wired into the build and into the release table", () => {
  test("`npm run gates` runs it", () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")).scripts;
    expect(scripts.gates).toMatch(/gate:composition/);
    expect(scripts["gate:composition"]).toBe("node tools/gates/checkCompositionRoot.js");
  });

  test("it is a blocking release gate, so a cutover cannot proceed past it", () => {
    const row = gates.GATE_BY_ID.engine_decision_path_wired;
    expect(row).toBeDefined();
    expect(row.blocking).toBe(true);
    expect(row.evidence).toBe(gates.EVIDENCE.BUILD);
    expect(row.command).toBe("npm run gate:composition");
  });
});

describe("THE FINDING — the real tree is still red, and this records exactly why", () => {
  test("the three wireable LEADER_ONLY workers are wired; the one external blocker is named", () => {
    // When this test was written it read "the two wireable … the two blocked ones", and it
    // was right. Phase 5's remediation closed the in-repository half of what remained: the
    // timer's blocker was the seventeen unimplemented §4.2/§4.3 expiry actions, and
    // `supervision/expiryActions.js` implements them, so the worker composes and starts.
    //
    // **This gate is still red, and it must be**, for a blocker no commit in this
    // repository can clear.
    const result = gate.checkCompositionRoot();

    expect(result.ok).toBe(false);

    // These three have production producers for every collaborator, and `leaderWorkers.js`
    // starts them on leadership acquisition.
    const stillFound = result.violations.map((v) => v.worker).sort();
    expect(stillFound).not.toContain("outbox");
    expect(stillFound).not.toContain("reconciler");
    expect(stillFound).not.toContain("timer");

    // What remains cannot be closed by wiring. It is reported with the blocker's owner, so
    // the gate's failure names who can clear it.
    const blocked = result.violations.filter((v) => v.kind === gate.FINDING.LEADER_ONLY_NOT_COMPOSABLE);
    expect(blocked.map((v) => v.worker).sort()).toEqual(["coordinator"]);
    for (const violation of blocked) {
      expect(violation.tier).toBe(0);
      expect(typeof violation.owner).toBe("string");
      expect(violation.owner.length).toBeGreaterThan(0);
      expect(Array.isArray(violation.requires)).toBe(true);
      expect(violation.requires.length).toBeGreaterThan(0);
    }

    // The distinction the whole finding turns on is preserved: what is left is an
    // Operations/Product/Commercial decision this repository cannot take, and it is
    // classified as external so that nobody reads it as unfinished wiring.
    const coordinator = blocked.find((v) => v.worker === "coordinator");
    expect(coordinator.external).toBe(true);
    expect(coordinator.detail).toMatch(/B1/);
  });

  test("PHASE 5 REGRESSION — the timer worker is reachable, composable, and started", () => {
    // Three separate properties, and the gate checks all three because the earlier
    // path-string proxy (D-10) could be satisfied by a comment. A worker that is reachable
    // but not composable is the state the timer was in; a worker that is composable but
    // whose composer refuses is the state the coordinator is in.
    const result = gate.checkCompositionRoot();
    const timerViolations = result.violations.filter((v) => v.worker === "timer");
    expect(timerViolations).toEqual([]);
    expect(typeof lifecycle.COMPOSERS.timer).toBe("function");
    expect(lifecycle.UNCOMPOSABLE.timer).toBeUndefined();
  });

  test("no LEADER_ONLY worker is silently skipped — every one has a composer", () => {
    // The failure this guards against: a worker in the registry that the lifecycle has never
    // heard of. Leadership would acquire, start the ones it knows, and skip that one without
    // a log line — which is the original D-5 defect reintroduced one layer in.
    for (const workerId of registry.scheduledOnLeadership()) {
      expect({ workerId, hasComposer: typeof lifecycle.COMPOSERS[workerId] === "function" }).toEqual({
        workerId,
        hasComposer: true,
      });
    }
  });
});
