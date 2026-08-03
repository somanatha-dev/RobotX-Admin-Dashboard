"use strict";

/**
 * Engine lane — Phase 0 scaffolding and guardrails.
 *
 * Phase 0 changes no runtime behaviour. What it must guarantee is that the
 * structures every later phase depends on exist, are complete, and are wired: the
 * module tree, the master switch, the component map, and the decision log.
 */

const fs = require("fs");
const path = require("path");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(BACKEND_ROOT, "..");
const ENGINE_ROOT = path.join(BACKEND_ROOT, "src", "engine");
const ADR_ROOT = path.join(REPO_ROOT, "docs", "adr");

const readEngineDoc = (name) => fs.readFileSync(path.join(ENGINE_ROOT, name), "utf8");

describe("the ENGINE_ENABLED master switch", () => {
  test("is off in the test environment", () => {
    expect(process.env.ENGINE_ENABLED).toBe("false");
  });

  test("is declared off in every environment file the plan names", () => {
    for (const file of [".env", ".env.benchmark"]) {
      const contents = fs.readFileSync(path.join(BACKEND_ROOT, file), "utf8");
      expect(contents).toMatch(/^ENGINE_ENABLED=false$/m);
    }
  });
});

describe("the engine module tree", () => {
  // One directory per component group of the execution plan's §2 capability
  // inventory. A later phase that needs a location must find it already decided.
  const REQUIRED_DIRECTORIES = [
    "candidates",
    "commitment",
    "config",
    "config/register",
    "cost",
    "degraded",
    "deps",
    "determinism",
    "dispatch",
    "domain",
    "domain/mappers",
    "energy",
    "failure",
    "fairness",
    "feasibility",
    "feasibility/predicates",
    "guards",
    "intake",
    "lifecycle",
    "map",
    "observability",
    "payload",
    "plan",
    "pricing",
    "privacy",
    "reliability",
    "routing",
    "security",
    "shard",
    "solve",
    "spatial",
    "stores",
    "supervision",
  ];

  test.each(REQUIRED_DIRECTORIES)("src/engine/%s exists", (directory) => {
    expect(fs.statSync(path.join(ENGINE_ROOT, directory)).isDirectory()).toBe(true);
  });

  test("the workers directory exists", () => {
    expect(fs.statSync(path.join(BACKEND_ROOT, "src", "workers")).isDirectory()).toBe(true);
  });

  // Phase 0 asserted the engine held *no* runtime code. Each landed phase widens
  // the assertion by exactly what it owns, rather than removing it. A module
  // appearing under `commitment/`, `feasibility/`, `dispatch/` or anywhere else
  // still fails this test, which is the property worth keeping — a later phase's
  // work leaking into an earlier one is caught mechanically rather than in review.
  //
  // Phase 2's additions are the §2 domain model, its legacy mappers, and the §3.6
  // spatial hierarchy. Phase 3's are the §10 commitment core and the minimal §19.5
  // leadership record guard G1 reads. Phase 4's are the §11 dispatch surface and the
  // §23.3 command envelope. Phase 5's are §4.5's durable timers, §12's supervision and
  // reconciliation, and the §4.2/§4.3/§4.4 lifecycle. Everything else remains forbidden
  // — a module under `feasibility/`, `solve/`, or `cost/` beyond Phase 1's two files
  // still fails this test.
  const PHASE_1_OWNED = [
    "config/",
    "cost/units.js",
    "cost/exchangeRates.js",
    "determinism/",
  ];

  const PHASE_2_OWNED = [
    "domain/",
    "spatial/",
  ];

  const PHASE_3_OWNED = [
    "commitment/",
    "shard/leadership.js",
  ];

  const PHASE_4_OWNED = [
    "dispatch/",
    "security/commandSigning.js",
  ];

  const PHASE_5_OWNED = [
    "supervision/",
    "lifecycle/",
  ];

  const LANDED_PHASE_OWNED = [
    ...PHASE_1_OWNED,
    ...PHASE_2_OWNED,
    ...PHASE_3_OWNED,
    ...PHASE_4_OWNED,
    ...PHASE_5_OWNED,
  ];

  test("holds runtime code only where a landed phase owns it", () => {
    const runtimeModules = [];
    const walk = (absolute, relative) => {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(absolute, entry.name), childRelative);
        else if (entry.name.endsWith(".js") && !childRelative.startsWith("guards/")) {
          runtimeModules.push(childRelative);
        }
      }
    };
    walk(ENGINE_ROOT, "");
    const unexpected = runtimeModules.filter(
      (module) => !LANDED_PHASE_OWNED.some((owned) => module === owned || module.startsWith(owned)),
    );
    expect(unexpected).toEqual([]);
  });

  test("Phase 1's own modules are all present", () => {
    for (const module of [
      "config/service.js",
      "config/resolver.js",
      "config/validators.js",
      "config/derived.js",
      "config/calibrationStatus.js",
      "config/killSwitches.js",
      "config/regimes.js",
      "cost/units.js",
      "cost/exchangeRates.js",
      "determinism/fixedPoint.js",
      "determinism/ordering.js",
      "determinism/snapshot.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 2's own modules are all present", () => {
    for (const module of [
      "domain/agent.js",
      "domain/mobilityModel.js",
      "domain/capability.js",
      "domain/work.js",
      "domain/purpose.js",
      "domain/custody.js",
      "domain/observation.js",
      "domain/mappers/legacyRobot.js",
      "domain/mappers/legacyTask.js",
      "spatial/hierarchy.js",
      "spatial/cells.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 2's backfill tool is present", () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, "tools", "migrate", "backfillDomain.js"))).toBe(true);
  });

  test("Phase 3's own modules are all present", () => {
    for (const module of [
      "commitment/model.js",
      "commitment/fencing.js",
      "commitment/guards.js",
      "commitment/commit.js",
      "commitment/leases.js",
      "commitment/idempotency.js",
      "commitment/clock.js",
      "shard/leadership.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 3's formal model is present", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "formal", "commitment.tla"))).toBe(true);
  });

  test("Phase 4's own modules are all present", () => {
    for (const module of [
      "dispatch/outbox.js",
      "dispatch/sequence.js",
      "dispatch/offers.js",
      "dispatch/escalation.js",
      "dispatch/dedupHandshake.js",
      "security/commandSigning.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 4's worker and socket handler are present", () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "workers", "outbox.worker.js"))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "sockets", "handlers", "offer.handler.js"))).toBe(true);
  });

  test("Phase 5's own modules are all present", () => {
    for (const module of [
      "supervision/timers.js",
      "supervision/leases.js",
      "supervision/progress.js",
      "supervision/reconciler.js",
      "supervision/verification.js",
      "lifecycle/legMachine.js",
      "lifecycle/taskMachine.js",
      "lifecycle/transitions.js",
      "lifecycle/settlement.js",
      "lifecycle/cancellation.js",
      "lifecycle/reassignment.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 5's workers and its operator-visibility route are present", () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "workers", "timer.worker.js"))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "workers", "reconciler.worker.js"))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "routes", "legs.routes.js"))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "controllers", "legs.controller.js"))).toBe(true);
  });

  test("no engine worker is started from server.js — Phase 15 owns that", () => {
    // §15's "All engine workers move from shadow to production scheduling". A worker
    // wired into the bootstrap would be an engine write path reachable with
    // ENGINE_ENABLED false, which is the one thing the master switch exists to prevent.
    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    expect(server).not.toMatch(/workers\/outbox\.worker/);
    expect(server).not.toMatch(/workers\/timer\.worker/);
    expect(server).not.toMatch(/workers\/reconciler\.worker/);
  });
});

describe("ARCHITECTURE.md", () => {
  const doc = readEngineDoc("ARCHITECTURE.md");

  test("maps every §3.2 component to a module path", () => {
    const COMPONENTS = [
      "Intake API",
      "Work Queue",
      "Assignment Coordinator",
      "Candidate Service",
      "Feasibility Evaluator",
      "Cost Evaluator",
      "Plan Builder",
      "Column Builder",
      "Solver",
      "Commitment Store",
      "Dispatcher",
      "Supervisor",
      "Reconciler",
      "Agent State Service",
      "Routing Service",
      "Forecast Service",
      "Capacity Pricing Service",
      "Reliability Service",
      "Energy Model Service",
      "Config Service",
      "Decision Log",
      "Explanation API",
      "Simulation Harness",
    ];
    for (const component of COMPONENTS) {
      const row = doc.split("\n").find((line) => line.startsWith(`| ${component} |`));
      expect({ component, mapped: Boolean(row) }).toEqual({ component, mapped: true });
      expect({ component, hasModulePath: /`src\/[^`]+`/.test(row) }).toEqual({
        component,
        hasModulePath: true,
      });
    }
  });

  test("states the L1–L4 layering and the exactly-once property of L3", () => {
    for (const layer of ["L4  DECISION LAYER", "L3  COMMITMENT LAYER", "L2  EXECUTION LAYER", "L1  STATE & ESTIMATION LAYER"]) {
      expect(doc).toContain(layer);
    }
    expect(doc).toMatch(/L1 may be lossy and L4 may be repeated, but L3 must be\s*\n?\s*exactly\s*\n?\s*once/);
  });

  test("records the rules the guardrails enforce, each against its gate", () => {
    expect(doc).toContain("tools/gates/checkTierDependencies.js");
    expect(doc).toContain("tools/gates/checkParameterRegister.js");
    expect(doc).toContain("src/engine/guards/tenets.js");
  });

  test("documents the master switch and its default", () => {
    expect(doc).toContain("ENGINE_ENABLED");
    expect(doc).toMatch(/default `false`/);
  });
});

describe("the ADR log", () => {
  const adrFiles = fs.readdirSync(ADR_ROOT).filter((f) => f.startsWith("ADR-"));

  test("records every decision in Appendix C of the frozen specification", () => {
    const spec = fs.readFileSync(
      path.join(REPO_ROOT, "NEXT_GENERATION_ASSIGNMENT_ENGINE.md"),
      "utf8",
    );
    const appendixC = spec.slice(spec.indexOf("## Appendix C"));
    const table = appendixC.slice(0, appendixC.indexOf("\n## ", 1));

    const ids = table
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|")[1].trim())
      .filter((id) => /^\d{2}[a-z]?$/.test(id));

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("01");
    expect(ids).toContain("32");

    for (const id of ids) {
      const match = adrFiles.find((file) => file.startsWith(`ADR-${id}-`));
      expect({ id, recorded: Boolean(match) }).toEqual({ id, recorded: true });
    }
    expect(adrFiles).toHaveLength(ids.length);
  });

  test("every record is accepted and frozen", () => {
    for (const file of adrFiles) {
      const contents = fs.readFileSync(path.join(ADR_ROOT, file), "utf8");
      expect({ file, frozen: contents.includes("**Accepted — frozen**") }).toEqual({
        file,
        frozen: true,
      });
      expect(contents).toMatch(/^## Decision$/m);
      expect(contents).toMatch(/^## Rejected$/m);
    }
  });

  test("the index lists every record and states the supersession rule", () => {
    const readme = fs.readFileSync(path.join(ADR_ROOT, "README.md"), "utf8");
    for (const file of adrFiles) expect(readme).toContain(file);
    expect(readme).toMatch(/supersed/i);
  });
});
