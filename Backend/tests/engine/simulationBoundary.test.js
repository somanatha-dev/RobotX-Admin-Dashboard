/**
 * TEST G — no architectural contamination from the simulation discriminator.
 *
 * ── Why a structural test and not a behavioural one ─────────────────────────
 * The property is an absence: the assignment engine must not be *able* to decide anything
 * differently for a simulated agent. There is no input that demonstrates an absence, and a
 * behavioural test would only show that the branch nobody wrote is not taken today. What
 * makes this checkable is the source itself, so this file reads it.
 *
 * The hazard being fenced off is specific and this programme has hit its shape before. If
 * `Robot.simulated` reaches the engine, then feasibility, cost, solve or commitment can
 * come to depend on it — and the moment they do, every result the simulated fleet produces
 * stops being evidence about the physical one. The simulator's entire value is that it
 * exercises the *same* decision path; a decision path that knows it is being simulated
 * exercises nothing.
 *
 * Simulation remains an agent/protocol test facility. It is not, and must not become, a
 * second assignment path, a second completion path, or a source of physical evidence.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "src");

/** Every `.js` file under `dir`, recursively, as `{ rel, source }`. */
function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        out.push({ rel: path.relative(SRC, full).replace(/\\/g, "/"), source: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Lines that reference the discriminator as a *value* — `robot.simulated`, `simulated:`,
 * `simulated ===`, a destructure of it.
 *
 * Prose is deliberately not matched. The words "simulated" and "simulation" appear in
 * comments across the engine (§24's simulation-fidelity gate is a real engine concept),
 * and a check that flagged those would be a check somebody weakens rather than obeys.
 */
function discriminatorReferences(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.source.split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      // `x.simulated`, `simulated:`, `simulated =`, `simulated,` (shorthand property or
      // destructure), `simulated)`. Verified against planted violations of each shape.
      if (/(^|[^\w.])simulated\s*[:=),]|\.simulated\b|{\s*[^}]*\bsimulated\b[^}]*}\s*=/.test(code)) {
        hits.push(`${file.rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return hits;
}

describe("Test G — the assignment engine cannot see the simulation discriminator", () => {
  test("no file under src/engine references Robot.simulated", () => {
    expect(discriminatorReferences(filesUnder(path.join(SRC, "engine")))).toEqual([]);
  });

  test("frozen decision logic does not branch on simulation", () => {
    // The four surfaces the Step 1 scope names explicitly: feasibility, cost, solve and
    // commitment. Listed separately from the blanket engine check above so that a future
    // reorganisation that moves one of them out of `src/engine` does not silently drop it
    // from coverage.
    for (const area of ["engine/feasibility", "engine/cost", "engine/solve", "engine/commitment", "engine/cutover"]) {
      expect({ area, hits: discriminatorReferences(filesUnder(path.join(SRC, area))) }).toEqual({
        area,
        hits: [],
      });
    }
  });

  test("the workers that drive a round do not reference it either", () => {
    expect(discriminatorReferences(filesUnder(path.join(SRC, "workers")))).toEqual([]);
  });

  test("the discriminator is confined to the lifecycle boundary", () => {
    // Where it IS allowed to appear: the simulation module that owns the decision, the
    // creation boundary that persists it, and the commissioning surface that reports it.
    // Anything else is a new reader, and a new reader is what this test is here to notice.
    const ALLOWED = new Set([
      "simulation/simulationPolicy.js",
      "simulation/SimulationEngine.js",
      "simulation/VirtualRobot.js",
      "simulation/rehydrate.js",
      "services/robot.service.js",
      "controllers/robots.controller.js",
      // STEP 2 — the dedicated simulated-creation flow. Two files, and only two: the
      // service that decides ownership and identity, and the controller that is the HTTP
      // surface for it. Both are *creation boundary*, which is the same category the two
      // entries above them are in — not a new category of reader.
      //
      // Added rather than the check being loosened. The list is still an allow-list of
      // exact paths, so a third file acquiring a reference still fails this test.
      "services/simulatedRobot.service.js",
      "controllers/simulator.controller.js",
      // STEP 3 — the public Robot projection. A *reporting* reader, and the only one:
      // its job is to put `simulated` on every robot payload as a boolean so the UI can
      // label a unit PHYSICAL or SIMULATED. It reads the flag through
      // `simulationPolicy.isSimulatedRobot` rather than re-deriving it, so the API's
      // answer and the simulator's answer are the same answer.
      //
      // Added rather than the check being loosened: this is still an allow-list of exact
      // paths, and a fifth file acquiring a reference still fails the test.
      "services/robotProjection.js",
      // STEP 5 — the position-Observation writer. A *labelling* reader, in the same
      // category as `robotProjection.js` above it: it reads the discriminator once, at the
      // point a telemetry frame becomes a §2.7 Observation, to stamp
      // `value.provenance = PHYSICAL | SIMULATED` on the row.
      //
      // This is the file that keeps the property this whole suite is about. Both kinds of
      // agent go through the same handler, produce the same `kind: "position"` row, are
      // indexed by the same worker into the same `AgentCellPosition`, and are read by the
      // same snapshot loader — so the engine still cannot tell them apart, which is what
      // the tests above assert. What the *evidence log* can tell apart is which agent was
      // real, which is a different question asked by a different reader.
      //
      // Registered here rather than evaded. The alternative — writing the same code
      // without a token this detector matches — would leave a reader of the discriminator
      // that the allow-list does not know about, which is worse than a listed one.
      "services/positionObservation.service.js",
      // V1 DEMONSTRATION (2026-09-23) — the two *provider* readers. Neither is in the
      // decision path, and the engine still cannot tell the two kinds of agent apart: both
      // hand back the same field names, and a missing field is simply missing.
      //
      //   · `agentFacts.service.js` is the one place that chooses a fact source per agent:
      //     the simulator's own state (`simulation/simulatedAgentState`) for a simulated
      //     unit, and nothing yet for a physical one — whose control-plane facts therefore
      //     stay absent and §7.5 denies them by name. It reads the flag through
      //     `simulationPolicy.isSimulatedRobot`.
      //   · `v1DemonstrationComposition.js` lists the simulated robots the
      //     DEVELOPMENT_SIMULATION router may serve, because `createSimulationRouter`
      //     refuses to be built for any agent that is not one.
      //
      // Registered here rather than evaded, for the reason given for the entry above.
      "services/agentFacts.service.js",
      "services/v1DemonstrationComposition.js",
    ]);

    const unexpected = discriminatorReferences(filesUnder(SRC)).filter(
      (hit) => !ALLOWED.has(hit.slice(0, hit.indexOf(":"))),
    );

    expect(unexpected).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2 — simulation OWNERSHIP is even more tightly confined than the flag
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lines referencing `simulationOwnerId` as a value, on the same terms as
 * `discriminatorReferences`: prose is not matched, code is.
 */
function ownershipReferences(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.source.split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (/\bsimulationOwnerId\b/.test(code)) {
        hits.push(`${file.rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return hits;
}

describe("Step 2 — simulation ownership never reaches the assignment engine", () => {
  // Why a *narrower* guard than the discriminator's: `Robot.simulated` at least describes
  // the agent. `simulationOwnerId` describes a *person*, and it is the kind of field that
  // spreads by being convenient — one `include`, one projection that spreads the whole
  // row, and operator identity is in a decision input, a telemetry frame, or an
  // explanation payload. §23.7's identity isolation makes that a privacy defect and not
  // merely an aesthetic one.
  //
  // So the allow-list here is three files: the two that create ownership, and the one
  // whose job is to strip it back out of the response.

  test("no file under src/engine references simulation ownership", () => {
    expect(ownershipReferences(filesUnder(path.join(SRC, "engine")))).toEqual([]);
  });

  test("frozen decision logic never sees an owner", () => {
    for (const area of [
      "engine/feasibility",
      "engine/cost",
      "engine/solve",
      "engine/commitment",
      "engine/cutover",
      "engine/supervision",
    ]) {
      expect({ area, hits: ownershipReferences(filesUnder(path.join(SRC, area))) }).toEqual({
        area,
        hits: [],
      });
    }
  });

  test("the workers that drive a round never see an owner", () => {
    expect(ownershipReferences(filesUnder(path.join(SRC, "workers")))).toEqual([]);
  });

  test("no simulator module sees an owner either", () => {
    // The VirtualRobot protocol carries telemetry and commands. Ownership is not a fleet
    // fact and has no business on the wire, so the whole simulation runtime is excluded —
    // ownership is decided at the HTTP boundary and never travels with the agent.
    expect(ownershipReferences(filesUnder(path.join(SRC, "simulation")))).toEqual([]);
  });

  test("ownership is confined to the creation boundary", () => {
    const ALLOWED = new Set([
      // Writes the column, from a parameter it is given — never from a request body.
      "services/robot.service.js",
      // Derives the owner from the authenticated operator, and refuses a caller-supplied one.
      "services/simulatedRobot.service.js",
      // STEP 3 — strips it back out of EVERY robot response before the projection leaves
      // the process. This entry replaces `controllers/simulator.controller.js`, which used
      // to hold a hand-written strip of its own: that strip was real, but it was the only
      // one, so `GET /api/robots` and `GET /api/robots/state` — which read the row with
      // `include` and therefore receive every scalar — were returning the owner's
      // `User.id` to every authenticated caller. The list is still three files, and the
      // stripping is now in the one place every robot payload passes through.
      "services/robotProjection.js",
    ]);

    const unexpected = ownershipReferences(filesUnder(SRC)).filter(
      (hit) => !ALLOWED.has(hit.slice(0, hit.indexOf(":"))),
    );

    expect(unexpected).toEqual([]);
  });

  test("the ownership detector is not vacuous", () => {
    // The same discipline Test G's detector was verified under: a check that matches
    // nothing passes for the wrong reason forever. It must find the real references, and
    // it must catch each shape a violation would take.
    const real = ownershipReferences(filesUnder(SRC));
    expect(real.length).toBeGreaterThan(0);

    const planted = [
      { rel: "engine/cost/planted.js", source: "const owner = robot.simulationOwnerId;" },
      { rel: "engine/solve/planted.js", source: "const { simulationOwnerId } = agent;" },
      { rel: "engine/feasibility/planted.js", source: "select: { simulationOwnerId: true }" },
    ];
    for (const violation of planted) {
      expect(ownershipReferences([violation])).toHaveLength(1);
    }

    // …and it must NOT fire on prose, or the check becomes one somebody weakens.
    expect(
      ownershipReferences([
        { rel: "engine/cost/prose.js", source: "// simulationOwnerId is not read here" },
        { rel: "engine/cost/prose2.js", source: " * simulationOwnerId never reaches this module" },
      ]),
    ).toEqual([]);
  });
});

describe("Test G — the simulator remains a protocol facility, not an assignment path", () => {
  test("no simulator module imports Prisma directly", () => {
    // The boundary the architecture assessment named. `SimulationEngine` receives a client
    // by injection from the composition root — which is what lets a test hand it a double
    // and what stops the simulator from opening its own connection to the fleet database.
    for (const file of filesUnder(path.join(SRC, "simulation"))) {
      const imports = [...file.source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      const prismaImports = imports.filter(
        (spec) => /@prisma\/client/.test(spec) || /(^|\/)db\/prisma$/.test(spec) || /prisma/i.test(spec),
      );
      expect({ file: file.rel, prismaImports }).toEqual({ file: file.rel, prismaImports: [] });
    }
  });

  test("no simulation-specific assignment, feasibility or cost algorithm exists", () => {
    const simulationFiles = filesUnder(path.join(SRC, "simulation"));

    for (const file of simulationFiles) {
      const imports = [...file.source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

      // The simulator may import the *shared* protocol and physics modules — that sharing
      // is the point (`chargeCurve` is imported "rather than a second implementation of
      // the same curve that a future edit could desynchronise"). It may not import the
      // decision engine, because an agent that can price its own offer is not an agent.
      const forbidden = imports.filter((spec) =>
        /engine\/(feasibility|cost|solve|commitment\/(?!fencing)|cutover|supervision)/.test(spec),
      );
      expect({ file: file.rel, forbidden }).toEqual({ file: file.rel, forbidden: [] });
    }
  });

  test("nothing outside src/simulation constructs a VirtualRobot", () => {
    const offenders = filesUnder(SRC)
      .filter((f) => !f.rel.startsWith("simulation/"))
      .filter((f) => /new\s+VirtualRobot\s*\(/.test(f.source))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });
});
