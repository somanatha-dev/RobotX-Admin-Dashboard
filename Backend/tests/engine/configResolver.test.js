"use strict";

/**
 * Engine lane — scope resolution (§22.2).
 *
 * The property under test is not "resolution returns a value" but "every effective
 * value is traceable to the scope level that supplied it". A resolver that returns
 * the right number without being able to say where it came from cannot answer "why is
 * this threshold 34?", which §22.2 makes a requirement rather than a nicety.
 */

const service = require("../../src/engine/config/service");
const {
  SCOPE_ORDER,
  VALUE_SOURCE,
  contextChain,
  permitsScope,
  normaliseScopeLevel,
} = require("../../src/engine/config/resolver");

const CONTEXT = {
  region: "eu-west",
  zone: "z-harbour",
  site: "depot-3",
  agent_class: "porter-2",
  agent: "agent-77",
  tenant: "acme",
  sla_class: "critical",
  mission_class: "delivery",
  time_window: "winter",
};

const bind = (level, key, name, value) => ({ level, key, name, value });

describe("the §22.2 hierarchy", () => {
  test("is exactly the specification's order, with zone between region and site", () => {
    expect(SCOPE_ORDER).toEqual([
      "global",
      "region",
      "zone",
      "site",
      "agent_class",
      "agent",
      "tenant",
      "sla_class",
      "mission_class",
      "time_window",
    ]);
    expect(SCOPE_ORDER.indexOf("zone")).toBeGreaterThan(SCOPE_ORDER.indexOf("region"));
    expect(SCOPE_ORDER.indexOf("zone")).toBeLessThan(SCOPE_ORDER.indexOf("site"));
  });

  test("a context addresses global plus every level it names, most specific last", () => {
    const chain = contextChain({ region: "eu-west", agent_class: "porter-2" });
    expect(chain.map((step) => step.level)).toEqual(["global", "region", "agent_class"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   §22.2's post-`site` branch — a recorded, UNRESOLVED specification ambiguity.

   Phase 1 independent verification, Part 4 / Part 12 issue 6.

   §22.2 draws the hierarchy as a tree, not a list:

       global → region → zone → site → agent_class → agent
                                     → tenant → sla_class → mission_class
                                     → time_window (scheduled overrides, incl. regimes)

   Three lines branch after `site`. The specification states precedence *along* each
   line and says nothing about precedence *between* them, and no other section of the
   frozen specification resolves it (searched: §22.2 in full, §22.3, §22.4, §3.6, and
   every other §22.2 cross-reference). Resolution nevertheless needs a total order, so
   the implementation linearises the branches in the order the specification prints
   them, with `time_window` last.

   **This is an implementation convention, not a specification rule, and Phase 1 has
   no authority to promote it into one.** These tests therefore pin the *current
   behaviour* so it cannot drift silently — not because the order is known to be
   right, but because an undocumented order that changes between releases would move
   resolutions nobody decided to move.

   ── What changed since the Phase 1 verification ──────────────────────────────
   The verifier confirmed that at Phase 1's 148-entry register, no parameter declared
   `scopes` in more than one branch, so the ambiguity had zero live exposure. That is
   **no longer true** at the current register: `energy.model_residual_cv` (§14.5) and
   `payload.packing_node_budget` (§15.3), both added by later phases, each declare
   `agent_class` *and* `mission_class` — one level from each of the first two
   branches. The exposure is still latent, because declaring a scope is not binding at
   one and neither parameter is bound at both levels in any published version; but it
   is no longer hypothetical, and the guard below is what will fail when it stops
   being latent.

   The decision this needs, stated so it can be taken by someone with the authority:
   **when a parameter is bound at two levels in different post-`site` branches and a
   resolution context addresses both, which branch wins?** Until that is answered, the
   printed order stands and is asserted here.
   ───────────────────────────────────────────────────────────────────────────── */

describe("§22.2 post-site branch precedence — preserved and pinned, not resolved", () => {
  const BRANCHES = Object.freeze({
    agent: ["agent_class", "agent"],
    subject: ["tenant", "sla_class", "mission_class"],
    scheduled: ["time_window"],
  });

  test("precedence WITHIN each branch is the specification's own printed order", () => {
    // This part is not ambiguous: §22.2 states it directly, line by line.
    for (const levels of Object.values(BRANCHES)) {
      const ranks = levels.map((level) => SCOPE_ORDER.indexOf(level));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(ranks.every((rank) => rank > SCOPE_ORDER.indexOf("site"))).toBe(true);
    }
  });

  test("precedence BETWEEN branches is the linearisation, and it is the printed order", () => {
    const rankOf = (level) => SCOPE_ORDER.indexOf(level);
    // agent branch, then subject branch, then scheduled overrides — as printed.
    expect(rankOf("agent")).toBeLessThan(rankOf("tenant"));
    expect(rankOf("mission_class")).toBeLessThan(rankOf("time_window"));
    // `time_window` last is the one part of the linearisation with a stated reason:
    // a scheduled override, including a regime, must be able to move a parameter, and
    // it cannot do that from anywhere but the most specific position.
    expect(SCOPE_ORDER[SCOPE_ORDER.length - 1]).toBe("time_window");
  });

  test("a parameter bound in two branches at once resolves by the linearisation", () => {
    // The behaviour the ambiguity governs, made explicit rather than left implicit.
    // `mission_class` outranks `agent_class` here **only** because it is printed later,
    // and that is exactly the decision the specification does not make.
    const snapshot = service.buildSnapshot({
      bindings: [
        bind("agent_class", "porter-2", "energy.model_residual_cv", 0.11),
        bind("mission_class", "delivery", "energy.model_residual_cv", 0.22),
      ],
    });
    const explanation = snapshot.explain("energy.model_residual_cv", CONTEXT);
    expect(explanation.level).toBe("mission_class");
    expect(explanation.value).toBe(0.22);

    // And the reverse context, addressing only the agent branch, resolves there —
    // so the linearisation is a tie-break between branches, not a demotion of one.
    const agentOnly = snapshot.explain("energy.model_residual_cv", { agent_class: "porter-2" });
    expect(agentOnly.level).toBe("agent_class");
    expect(agentOnly.value).toBe(0.11);
  });

  test("a scheduled override still wins over every branch, which is what lets a regime move a parameter", () => {
    const snapshot = service.buildSnapshot({
      bindings: [
        bind("agent", "agent-77", "connectivity.max_heartbeat_age", 11),
        bind("mission_class", "delivery", "connectivity.max_heartbeat_age", 12),
        bind("time_window", "winter", "connectivity.max_heartbeat_age", 13),
      ],
    });
    expect(snapshot.explain("connectivity.max_heartbeat_age", CONTEXT).level).toBe("time_window");
  });

  test("GUARD: reports which registered parameters can reach the ambiguity", () => {
    // Not a prohibition — declaring scopes in two branches is legitimate and two
    // parameters already do. This asserts the *count is known*, so that a future
    // phase widening the exposure has to come past this test and read the paragraph
    // above rather than discovering the ambiguity in production.
    const spanning = [];
    for (const [name, entry] of service.loadRegister().entries) {
      const scopes = entry.scopes || [];
      const branchesTouched = Object.values(BRANCHES).filter((levels) =>
        levels.some((level) => scopes.includes(level)),
      ).length;
      if (branchesTouched > 1) spanning.push(name);
    }

    expect(spanning.sort()).toEqual(["energy.model_residual_cv", "payload.packing_node_budget"]);
  });
});

describe("most-specific-wins resolution", () => {
  test("each level in turn overrides the one above it, and explain names the winner", () => {
    const levels = ["region", "zone", "site", "agent_class", "agent"];
    let bindings = [];
    let expected = 10;

    // Default first — nothing bound.
    let snapshot = service.buildSnapshot({ bindings });
    expect(snapshot.explain("connectivity.max_heartbeat_age", CONTEXT).source).toBe(VALUE_SOURCE.DEFAULT);

    for (const level of levels) {
      expected += 1;
      bindings = [...bindings, bind(level, CONTEXT[level], "connectivity.max_heartbeat_age", expected)];
      snapshot = service.buildSnapshot({ bindings });
      const explanation = snapshot.explain("connectivity.max_heartbeat_age", CONTEXT);
      expect({ level, value: explanation.value, from: explanation.level }).toEqual({
        level,
        value: expected,
        from: level,
      });
      expect(explanation.source).toBe(VALUE_SOURCE.BINDING);
    }
  });

  test("zone overrides region — the level §22.2 insists is a scope, not merely an index key", () => {
    const snapshot = service.buildSnapshot({
      bindings: [
        bind("region", "eu-west", "connectivity.max_deadzone_extension", 100),
        bind("zone", "z-harbour", "connectivity.max_deadzone_extension", 200),
      ],
    });
    const explanation = snapshot.explain("connectivity.max_deadzone_extension", CONTEXT);
    expect(explanation.value).toBe(200);
    expect(explanation.level).toBe("zone");
  });

  test("site overrides zone — a depot's model overrides the surrounding zone's", () => {
    const snapshot = service.buildSnapshot({
      bindings: [
        bind("zone", "z-harbour", "verify.arrival_radius", 30),
        bind("site", "depot-3", "verify.arrival_radius", 8),
      ],
    });
    expect(snapshot.explain("verify.arrival_radius", CONTEXT).level).toBe("site");
    expect(snapshot.resolve("verify.arrival_radius", CONTEXT)).toBe(8);
  });

  test("a binding at a level the context does not address is not applied", () => {
    const snapshot = service.buildSnapshot({
      bindings: [bind("zone", "z-elsewhere", "verify.arrival_radius", 99)],
    });
    expect(snapshot.explain("verify.arrival_radius", CONTEXT).source).toBe(VALUE_SOURCE.DEFAULT);
  });

  test("a time-windowed override is the most specific level, so a regime can move a parameter", () => {
    const snapshot = service.buildSnapshot({
      bindings: [
        bind("agent", "agent-77", "execute.start_grace", 30),
        bind("time_window", "winter", "execute.start_grace", 240),
      ],
    });
    expect(snapshot.explain("execute.start_grace", CONTEXT).level).toBe("time_window");
  });
});

describe("the resolution explanation", () => {
  const snapshot = service.buildSnapshot({
    bindings: [bind("region", "eu-west", "dispatch.retry_window", 15)],
  });

  test("carries the supplying level, the unit, the class, the owner and the calibration status", () => {
    const explanation = snapshot.explain("dispatch.retry_window", CONTEXT);
    expect(explanation).toMatchObject({
      name: "dispatch.retry_window",
      value: 15,
      source: VALUE_SOURCE.BINDING,
      level: "region",
      key: "eu-west",
      unit: "s",
      changeClass: "TUNED",
      owner: "Eng",
      calibrationStatus: "PROVISIONAL",
    });
  });

  test("shows the levels it considered, so the answer is checkable rather than asserted", () => {
    const explanation = snapshot.explain("dispatch.retry_window", CONTEXT);
    expect(explanation.chain.map((step) => step.level)).toEqual(contextChain(CONTEXT).map((step) => step.level));
    expect(explanation.chain.find((step) => step.level === "region").bound).toBe(true);
    expect(explanation.chain.find((step) => step.level === "site").bound).toBe(false);
  });

  test("distinguishes a derived value from a default and from an unset one", () => {
    const derived = snapshot.explain("energy.contingency_quantile");
    expect(derived.source).toBe(VALUE_SOURCE.DERIVED);

    expect(snapshot.explain("solve.window_min").source).toBe(VALUE_SOURCE.DEFAULT);
    expect(snapshot.explain("cost.energy.cu_per_wh").source).toBe(VALUE_SOURCE.UNSET);
  });

  test("names an unregistered parameter as unknown rather than returning undefined", () => {
    const explanation = snapshot.explain("cost.made_up_weight");
    expect(explanation.source).toBe(VALUE_SOURCE.UNKNOWN_PARAMETER);
    expect(explanation.detail).toMatch(/not in the parameter register/);
  });
});

describe("indexed parameters", () => {
  const snapshot = service.defaultSnapshot();

  test("resolve to the whole map, or to one index when asked", () => {
    expect(snapshot.resolve("energy.event_budget_per_fleet_year")).toEqual({ T1: 365000, T2: 365, T3: 4 });
    expect(snapshot.resolve("energy.event_budget_per_fleet_year", {}, { index: "T2" })).toBe(365);
  });

  test("an unknown index resolves to null rather than to a neighbouring tier's value", () => {
    expect(snapshot.resolve("energy.event_budget_per_fleet_year", {}, { index: "T9" })).toBeNull();
  });
});

describe("scope admissibility", () => {
  const entries = service.loadRegister().entries;

  test("a parameter may only be bound at a level it declares", () => {
    expect(permitsScope(entries.get("verify.arrival_radius"), "site")).toBe(true);
    expect(permitsScope(entries.get("verify.arrival_radius"), "agent")).toBe(false);
  });

  test("Appendix A's `shard` and `fleet` map onto region and global", () => {
    expect(normaliseScopeLevel("shard")).toBe("region");
    expect(normaliseScopeLevel("fleet")).toBe("global");
    expect(permitsScope(entries.get("commit.max_serial_utilisation"), "shard")).toBe(true);
  });

  test("a binding naming a level outside the hierarchy is refused at index time", () => {
    expect(() => service.buildSnapshot({ bindings: [bind("rack", "r1", "solve.window_min", 100)] })).toThrow(
      /not a §22.2 level/,
    );
  });
});
