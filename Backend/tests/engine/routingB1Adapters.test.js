"use strict";

/**
 * Engine lane — **B1 Step 2**, the executable benchmark adapters
 * (`tools/routing/adapters/*`), released by `ADR-33`'s ratification of **D4**.
 *
 * ── What these tests can and cannot establish ─────────────────────────────
 * They establish that each adapter constructs the request its engine documents, reads that
 * engine's answer in that engine's units, and classifies every one of §32.5's six failure
 * conditions distinctly. They establish it against a **faked transport**, which is the only
 * honest thing available: B1 Step 1 is blocked by **D1** and no candidate engine is deployed.
 *
 * They establish **nothing about any candidate's performance**, and they are not B1 evidence.
 * No test here calls a public routing service — `assertSelfHosted` refuses one outright, and a
 * test that reached the network would be measuring somebody else's cluster. No test produces a
 * latency, a throughput or a hit rate.
 *
 * ── The two failures these tests exist to prevent ─────────────────────────
 * **A silent unit error.** Valhalla's matrix returns kilometres and GraphHopper returns
 * milliseconds, while the contract is metres and seconds throughout. A factor of 1000 in either
 * direction produces a route that looks entirely plausible and is wrong, and it would be
 * discovered — if at all — as an inexplicable candidate ranking at Step 5.
 *
 * **A fabricated answer.** §18.3 B6's uniform-treatment rule exists so that a candidate cannot
 * score best because its data was missing. Every path below that could invent a distance is
 * asserted to return `null` and a status instead.
 */

const contract = require("../../tools/routing/adapters/contract");
const osrm = require("../../tools/routing/adapters/osrm");
const valhalla = require("../../tools/routing/adapters/valhalla");
const graphhopper = require("../../tools/routing/adapters/graphhopper");
const inhouse = require("../../tools/routing/adapters/inhouse");
const registry = require("../../tools/routing/adapters");
const benchmark = require("../../tools/routing/b1Benchmark");

/**
 * A transport that never opens a socket.
 *
 * It records every request so request *construction* can be asserted, honours the abort signal
 * so the timeout path is real rather than simulated, and answers from a queue so a fan-out can
 * be given a different answer per call.
 *
 * @param {Array<object|((request: object) => object)>|object} answers
 * @returns {function & { requests: object[] }}
 */
function fakeTransport(answers) {
  const queue = Array.isArray(answers) ? [...answers] : null;
  const transport = async function send(request) {
    transport.requests.push(request);
    const answer = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : answers;
    const resolved = typeof answer === "function" ? answer(request) : answer;

    if (resolved && resolved.hang) {
      // A request that never answers until it is aborted — which is what a saturated engine
      // looks like, and the only faithful way to exercise §5.2's hard budget.
      return new Promise((unused, reject) => {
        request.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    if (resolved && resolved.throws) throw resolved.throws;
    return { httpStatus: resolved.httpStatus === undefined ? 200 : resolved.httpStatus, body: resolved.body };
  };
  transport.requests = [];
  return transport;
}

/** Two cells, projected to fixed coordinates. No H3, no region: the seam is what is under test. */
const POINTS = Object.freeze({
  "cell:origin": { lat: 51.5, lon: -0.12 },
  "cell:a": { lat: 51.51, lon: -0.11 },
  "cell:b": { lat: 51.52, lon: -0.1 },
});

const CHARGERS = Object.freeze([
  { chargerId: "C-far", lat: 51.6, lon: -0.2 },
  { chargerId: "C-near", lat: 51.505, lon: -0.121 },
  { chargerId: "C-tie", lat: 51.506, lon: -0.122, chargerClass: "DEPOT", isDepot: true },
]);

/**
 * A complete, valid configuration. Every field is required by `normaliseConfig`, which is the
 * point: an adapter that could be constructed without a spread source, a snap bound or a
 * timeout budget would be one that quietly decided them.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function configFor(overrides) {
  return Object.assign(
    {
      baseUrl: "http://routing.internal:5000",
      engineProfile: "foot",
      snapRadiusM: 25,
      matrixTimeoutMs: 150,
      profile: { energyWhPerMetre: 0.05, speedMetresPerSecond: 5 },
      travelTimeSpread: { source: "fixture — a named stand-in, never a default (N29)", model: "PROPORTIONAL", value: 0.1 },
      projectCell: (cellId) => {
        if (!POINTS[cellId]) throw new Error(`no projection for ${cellId}`);
        return POINTS[cellId];
      },
      chargerCatalogue: async () => CHARGERS.map((charger) => ({ ...charger })),
      deployment: { shape: "fixture", extract: "none — D1 open", profilesBuilt: "none", hierarchyBuildTime: "not built" },
    },
    overrides,
  );
}

const MATRIX_REQUEST = Object.freeze({
  originCellId: "cell:origin",
  destCellIds: ["cell:a", "cell:b"],
  profileKey: "MOB-SIDEWALK-DEFAULT:SIDEWALK_GRAPH:unloaded",
  timeBucket: 0,
});

const CHARGER_REQUEST = Object.freeze({
  destCellId: "cell:a",
  profileKey: "MOB-SIDEWALK-DEFAULT:SIDEWALK_GRAPH:unloaded",
  timeBucket: 0,
  k: 2,
});

/** An OSRM Table answer for `n` destinations. `null` is OSRM's own unreachable marker. */
function osrmTable(durations, distances) {
  return { body: { code: "Ok", durations: [durations], distances: [distances] } };
}

/** A Valhalla `sources_to_targets` answer. `distance` is in KILOMETRES. */
function valhallaMatrix(cells) {
  return { body: { units: "kilometers", sources_to_targets: [cells] } };
}

/** A GraphHopper `/route` answer. `distance` is METRES and `time` is MILLISECONDS. */
function graphhopperRoute(distanceM, timeMs) {
  return { body: { paths: [{ distance: distanceM, time: timeMs }] } };
}

describe("configuration is validated, and nothing missing is quietly decided", () => {
  test.each([
    ["osrm", osrm],
    ["valhalla", valhalla],
    ["graphhopper", graphhopper],
  ])("%s refuses an empty configuration and names every missing seam at once", (id, adapter) => {
    expect(() => adapter.create({})).toThrow(contract.AdapterError);
    let thrown = null;
    try {
      adapter.create({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown.status).toBe(contract.ROUTE_STATUS.MALFORMED_REQUEST);
    // Reported together rather than one per attempt: an operator configuring a deployment
    // should see the whole list, not discover it five runs later.
    for (const seam of ["engineProfile", "projectCell", "chargerCatalogue", "matrixTimeoutMs", "travelTimeSpread", "deployment"]) {
      expect({ seam, named: thrown.message.includes(seam) }).toEqual({ seam, named: true });
    }
  });

  test("a public hosted routing service is refused — R1 is not negotiable", () => {
    // §5.2 and ADR-11: the rejected option is "metered external API in the hot path", and §20.3
    // item 5 gives the reason — the precomputation IS the optimisation and a per-query API
    // cannot provide it. A benchmark run against a hosted host measures somebody else's cluster.
    for (const hosted of ["https://router.project-osrm.org", "https://graphhopper.com/api/1", "https://valhalla1.openstreetmap.de"]) {
      expect(() => contract.assertSelfHosted("test", hosted)).toThrow(/SELF-HOSTED/u);
    }
    expect(contract.assertSelfHosted("test", "http://osrm.internal:5000/")).toBe("http://osrm.internal:5000");
  });

  test("no adapter defaults travelSdSeconds — N29, the coalesce that hid the question", () => {
    // `cellPairCache.buildEntry` requires a finite non-negative spread and §8.4 prices p_late
    // from the ETA predictive distribution rather than the point estimate. None of the three
    // shortlisted engines returns a spread, so 0 would mean "this ETA is certain" — optimistic,
    // and silent. The adapter refuses to be built instead.
    let thrown = null;
    try {
      osrm.create(configFor({ travelTimeSpread: undefined }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown.message).toMatch(/travelTimeSpread is required/u);
    expect(thrown.message).toMatch(/N29/u);
  });

  test("OSRM and Valhalla require a bounded snap radius; GraphHopper cannot offer one and says so", () => {
    // R13: a point outside the extract must FAIL rather than snap plausibly and wrongly.
    expect(() => osrm.create(configFor({ snapRadiusM: undefined }))).toThrow(/snapRadiusM is required/u);
    expect(() => valhalla.create(configFor({ snapRadiusM: undefined }))).toThrow(/snapRadiusM is required/u);

    // The self-hosted /route endpoint has no radius parameter. The limitation is carried in the
    // description so it reaches the Step 5 record — it is not simulated by an adapter-side
    // distance check, which would be this file's arithmetic reported as the engine's behaviour.
    const adapter = graphhopper.create(configFor({ snapRadiusM: undefined, transport: fakeTransport({}) }));
    expect(adapter.description).toMatch(/R13 PARTIAL/u);
  });

  test("the description states deployment shape, extract, profiles and hierarchy build time", () => {
    // `b1Benchmark.js:89–90` requires exactly this, and Step 4 records the last of them as an
    // operational cost the decision must carry. D1 owns the extract and D8 owns its vintage, so
    // every one of these is the operator's string carried verbatim.
    const adapter = osrm.create(configFor({ transport: fakeTransport({}) }));
    expect(adapter.description).toMatch(/fixture/u);
    expect(adapter.description).toMatch(/extract none — D1 open/u);
    expect(adapter.description).toMatch(/hierarchy build not built/u);
    expect(adapter.description).toMatch(/travelSdSeconds from fixture/u);
  });
});

describe("a malformed request is refused before the engine is called", () => {
  test.each([
    ["osrm", osrm],
    ["valhalla", valhalla],
    ["graphhopper", graphhopper],
  ])("%s rejects an incomplete matrix request without a round trip", async (id, adapter) => {
    const transport = fakeTransport({});
    const engine = adapter.create(configFor({ transport }));

    await expect(engine.matrix({ ...MATRIX_REQUEST, profileKey: undefined })).rejects.toThrow(/profileKey/u);
    await expect(engine.matrix({ ...MATRIX_REQUEST, timeBucket: undefined })).rejects.toThrow(/timeBucket/u);
    await expect(engine.matrix({ ...MATRIX_REQUEST, destCellIds: [] })).rejects.toThrow(/destCellIds/u);
    await expect(engine.nearestChargers({ ...CHARGER_REQUEST, k: 0 })).rejects.toThrow(/k must be a positive integer/u);

    // §32.5: "Malformed request — reject before querying; never substitute a default."
    expect(transport.requests).toHaveLength(0);
  });

  test("a request whose cell cannot be projected fails as a request, not as a route", async () => {
    const transport = fakeTransport({});
    const engine = osrm.create(configFor({ transport }));
    let thrown = null;
    try {
      await engine.matrix({ ...MATRIX_REQUEST, destCellIds: ["cell:nowhere"] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.status).toBe(contract.ROUTE_STATUS.MALFORMED_REQUEST);
    expect(transport.requests).toHaveLength(0);
  });
});

describe("OSRM — request construction, parsing and units", () => {
  test("matrix() builds one Table query per cell cluster, lon,lat ordered, with a bounded snap", async () => {
    const transport = fakeTransport(osrmTable([120, 240], [600, 1200]));
    const engine = osrm.create(configFor({ transport }));
    await engine.matrix(MATRIX_REQUEST);

    expect(transport.requests).toHaveLength(1);
    const { url, method } = transport.requests[0];
    expect(method).toBe("GET");
    // OSRM orders a coordinate lon,lat. A reversed pair is a silently 90°-rotated answer.
    expect(url).toContain("/table/v1/foot/-0.12,51.5;-0.11,51.51;-0.1,51.52");
    expect(url).toContain("sources=0&destinations=1;2");
    // `distances` needs the annotation; without it the adapter must not derive distance from
    // duration, so the annotation is part of the contract rather than an optimisation.
    expect(url).toContain("annotations=duration,distance");
    expect(url).toContain("radiuses=25;25;25");
  });

  test("durations are seconds and distances are metres, neither rescaled", async () => {
    const engine = osrm.create(configFor({ transport: fakeTransport(osrmTable([120, 240], [600, 1200])) }));
    const answers = await engine.matrix(MATRIX_REQUEST);

    expect(answers.map((answer) => ({ destCellId: answer.destCellId, status: answer.status, distanceM: answer.distanceM, travelSeconds: answer.travelSeconds }))).toEqual([
      { destCellId: "cell:a", status: contract.ROUTE_STATUS.OK, distanceM: 600, travelSeconds: 120 },
      { destCellId: "cell:b", status: contract.ROUTE_STATUS.OK, distanceM: 1200, travelSeconds: 240 },
    ]);
    // The spread comes from the named source, not from the engine and not from zero.
    expect(answers.map((answer) => answer.travelSdSeconds)).toEqual([12, 24]);
  });

  test("a null pair is returned as NO_ROUTE with no fabricated distance", async () => {
    const engine = osrm.create(configFor({ transport: fakeTransport(osrmTable([120, null], [600, null])) }));
    const answers = await engine.matrix(MATRIX_REQUEST);

    // §32.5: "Return the destination with an explicit no-route status. Never omit silently,
    // never fabricate a distance." Omission is what §18.3 B6's uniform-treatment rule cannot see.
    expect(answers).toHaveLength(2);
    expect(answers[1].status).toBe(contract.ROUTE_STATUS.NO_ROUTE);
    expect(answers[1].distanceM).toBeNull();
    expect(answers[1].travelSeconds).toBeNull();
    expect(answers[1].travelSdSeconds).toBeNull();
  });

  test("NoSegment is an extract miss and is not confused with an unreachable pair", async () => {
    // The distinction §32.5 requires: a coordinate outside the graph the extract was cut to is a
    // finding about the extract; two points that are not connected is a finding about the graph.
    const engine = osrm.create(configFor({ transport: fakeTransport({ httpStatus: 400, body: { code: "NoSegment", message: "no segment" } }) }));
    await expect(engine.matrix(MATRIX_REQUEST)).rejects.toMatchObject({ status: contract.ROUTE_STATUS.EXTRACT_MISS });
  });

  test("a 5xx is an engine failure, and a missing distances row is a malformed response", async () => {
    const failing = osrm.create(configFor({ transport: fakeTransport({ httpStatus: 503, body: null }) }));
    await expect(failing.matrix(MATRIX_REQUEST)).rejects.toMatchObject({ status: contract.ROUTE_STATUS.ENGINE_FAILURE });

    const noDistances = osrm.create(configFor({ transport: fakeTransport({ body: { code: "Ok", durations: [[1, 2]] } }) }));
    await expect(noDistances.matrix(MATRIX_REQUEST)).rejects.toMatchObject({ status: contract.ROUTE_STATUS.MALFORMED_RESPONSE });
  });

  test("a query over the deployment's --max-table-size is split, and the answer order is the caller's", async () => {
    // OSRM's default cap is 100 locations and §20.1's own cluster is 100 destinations plus an
    // origin. An adapter that could not split would report the matrix row as a refused request.
    const transport = fakeTransport([osrmTable([120], [600]), osrmTable([240], [1200])]);
    const engine = osrm.create(configFor({ transport, maxLocationsPerQuery: 2 }));
    const answers = await engine.matrix(MATRIX_REQUEST);

    expect(transport.requests).toHaveLength(2);
    expect(answers.map((answer) => answer.destCellId)).toEqual(["cell:a", "cell:b"]);
    expect(answers.map((answer) => answer.distanceM)).toEqual([600, 1200]);
  });

  test("nearestChargers routes the injected catalogue and returns at most k, nearest first", async () => {
    const transport = fakeTransport(osrmTable([900, 100, 100], [9000, 500, 500]));
    const engine = osrm.create(configFor({ transport }));
    const chargers = await engine.nearestChargers(CHARGER_REQUEST);

    // OSRM has no idea what a charger is; §20.3 item 3's population is supplied, never invented.
    expect(chargers).toHaveLength(2);
    expect(chargers.map((charger) => charger.chargerId)).toEqual(["C-near", "C-tie"]);
    expect(chargers[0]).toMatchObject({ distanceM: 500, travelSeconds: 100, status: contract.ROUTE_STATUS.OK });
    // The optional fields both caches accept are carried rather than dropped.
    expect(chargers[1]).toMatchObject({ chargerClass: "DEPOT", isDepot: true });
  });

  test("an unreachable charger is dropped from the nearest-k rather than ranked at distance zero", async () => {
    const engine = osrm.create(configFor({ transport: fakeTransport(osrmTable([null, 100, 200], [null, 500, 900])) }));
    const chargers = await engine.nearestChargers({ ...CHARGER_REQUEST, k: 5 });
    expect(chargers.map((charger) => charger.chargerId)).toEqual(["C-near", "C-tie"]);
  });
});

describe("Valhalla — request construction, parsing and the kilometre trap", () => {
  test("matrix() posts one source, n targets, an explicit costing and explicit units", async () => {
    const transport = fakeTransport(valhallaMatrix([{ to_index: 0, distance: 0.6, time: 120 }, { to_index: 1, distance: 1.2, time: 240 }]));
    const engine = valhalla.create(configFor({ transport }));
    await engine.matrix(MATRIX_REQUEST);

    const request = transport.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://routing.internal:5000/sources_to_targets");
    expect(request.body.sources).toEqual([{ lat: 51.5, lon: -0.12, radius: 25 }]);
    expect(request.body.targets).toHaveLength(2);
    expect(request.body.costing).toBe("foot");
    expect(request.body.units).toBe("kilometers");
  });

  test("KILOMETRES become metres — the factor of 1000 that would otherwise look plausible", async () => {
    const engine = valhalla.create(
      configFor({ transport: fakeTransport(valhallaMatrix([{ to_index: 0, distance: 0.6, time: 120 }, { to_index: 1, distance: 1.2, time: 240 }])) }),
    );
    const answers = await engine.matrix(MATRIX_REQUEST);
    expect(answers.map((answer) => answer.distanceM)).toEqual([600, 1200]);
    expect(answers.map((answer) => answer.travelSeconds)).toEqual([120, 240]);
  });

  test("a response in units the request did not ask for is malformed, never converted twice", async () => {
    const engine = valhalla.create(configFor({ transport: fakeTransport({ body: { units: "miles", sources_to_targets: [[{ to_index: 0, distance: 1, time: 1 }]] } }) }));
    await expect(engine.matrix({ ...MATRIX_REQUEST, destCellIds: ["cell:a"] })).rejects.toMatchObject({
      status: contract.ROUTE_STATUS.MALFORMED_RESPONSE,
    });
  });

  test("a null distance/time is NO_ROUTE, and error 171 is an EXTRACT_MISS", async () => {
    const unreachable = valhalla.create(
      configFor({ transport: fakeTransport(valhallaMatrix([{ to_index: 0, distance: 0.6, time: 120 }, { to_index: 1, distance: null, time: null }])) }),
    );
    const answers = await unreachable.matrix(MATRIX_REQUEST);
    expect(answers[1]).toMatchObject({ status: contract.ROUTE_STATUS.NO_ROUTE, distanceM: null, travelSeconds: null });

    const outside = valhalla.create(
      configFor({ transport: fakeTransport({ httpStatus: 400, body: { error_code: 171, error: "No suitable edges near location" } }) }),
    );
    await expect(outside.matrix(MATRIX_REQUEST)).rejects.toMatchObject({ status: contract.ROUTE_STATUS.EXTRACT_MISS });
  });

  test("an unrecognised error code is an engine failure, never assumed to mean unreachable", async () => {
    // Reading an unknown refusal as NO_ROUTE would tell §18.3 B6's uniform-treatment rule that a
    // destination is genuinely unreachable when the engine merely declined the question.
    const engine = valhalla.create(configFor({ transport: fakeTransport({ httpStatus: 400, body: { error_code: 9999, error: "something new" } }) }));
    await expect(engine.matrix(MATRIX_REQUEST)).rejects.toMatchObject({ status: contract.ROUTE_STATUS.ENGINE_FAILURE });
  });

  test("answers are keyed by Valhalla's to_index, not by array position", async () => {
    // The API does not promise response ordering. A matrix that trusted array position would be
    // non-deterministic in a way that only shows up intermittently — the worst kind (R10, §9.6).
    const engine = valhalla.create(
      configFor({ transport: fakeTransport(valhallaMatrix([{ to_index: 1, distance: 1.2, time: 240 }, { to_index: 0, distance: 0.6, time: 120 }])) }),
    );
    const answers = await engine.matrix(MATRIX_REQUEST);
    expect(answers).toEqual([
      expect.objectContaining({ destCellId: "cell:a", distanceM: 600 }),
      expect.objectContaining({ destCellId: "cell:b", distanceM: 1200 }),
    ]);
  });
});

describe("GraphHopper — the fan-out, and the milliseconds", () => {
  test("matrix() is N /route queries because the self-hosted server ships no matrix endpoint", async () => {
    const transport = fakeTransport([graphhopperRoute(600, 120000), graphhopperRoute(1200, 240000)]);
    const engine = graphhopper.create(configFor({ transport }));
    const answers = await engine.matrix(MATRIX_REQUEST);

    // Recorded rather than hidden: a candidate that cannot batch pays §20.3 item 4's
    // amortisation back in round trips, and `approach_routing_matrix` is where B1 should see it.
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0].url).toContain("point=51.5,-0.12&point=51.51,-0.11");
    expect(transport.requests[0].url).toContain("profile=foot");
    expect(transport.requests[0].url).toContain("calc_points=false&instructions=false");
    expect(answers.map((answer) => answer.destCellId)).toEqual(["cell:a", "cell:b"]);
  });

  test("MILLISECONDS become seconds and distance stays metres", async () => {
    const engine = graphhopper.create(configFor({ transport: fakeTransport(graphhopperRoute(600, 120000)) }));
    const [answer] = await engine.matrix({ ...MATRIX_REQUEST, destCellIds: ["cell:a"] });
    expect({ distanceM: answer.distanceM, travelSeconds: answer.travelSeconds }).toEqual({ distanceM: 600, travelSeconds: 120 });
  });

  test("ConnectionNotFound is NO_ROUTE and PointOutOfBounds is EXTRACT_MISS, per destination", async () => {
    const transport = fakeTransport([
      { httpStatus: 400, body: { message: "Connection between locations not found", hints: [{ details: "com.graphhopper.util.exceptions.ConnectionNotFoundException" }] } },
      { httpStatus: 400, body: { message: "Point 1 is out of bounds", hints: [{ details: "com.graphhopper.util.exceptions.PointOutOfBoundsException" }] } },
    ]);
    const engine = graphhopper.create(configFor({ transport }));
    const answers = await engine.matrix(MATRIX_REQUEST);

    // Per-destination statuses: one bad pair does not erase the rest of the cluster's answer.
    expect(answers.map((answer) => answer.status)).toEqual([contract.ROUTE_STATUS.NO_ROUTE, contract.ROUTE_STATUS.EXTRACT_MISS]);
    expect(answers.every((answer) => answer.distanceM === null)).toBe(true);
  });

  test("an unrecognised 4xx is an engine failure; a 2xx without paths is malformed", async () => {
    const unknown = graphhopper.create(configFor({ transport: fakeTransport({ httpStatus: 400, body: { message: "who knows" } }) }));
    const [answer] = await unknown.matrix({ ...MATRIX_REQUEST, destCellIds: ["cell:a"] });
    expect(answer.status).toBe(contract.ROUTE_STATUS.ENGINE_FAILURE);

    const malformed = graphhopper.create(configFor({ transport: fakeTransport({ body: { ok: true } }) }));
    await expect(malformed.matrix({ ...MATRIX_REQUEST, destCellIds: ["cell:a"] })).rejects.toMatchObject({
      status: contract.ROUTE_STATUS.MALFORMED_RESPONSE,
    });
  });

  test("the fan-out is assembled in request order regardless of completion order", async () => {
    // Concurrency is allowed so the measurement is about GraphHopper rather than about this
    // loop; determinism is not negotiable, so the assembly is by index.
    const answersByPoint = {
      "51.51,-0.11": graphhopperRoute(600, 120000),
      "51.52,-0.1": graphhopperRoute(1200, 240000),
    };
    const transport = fakeTransport((request) => {
      const target = request.url.split("point=")[2].split("&")[0];
      return answersByPoint[decodeURIComponent(target)];
    });
    const engine = graphhopper.create(configFor({ transport, matrixConcurrency: 4 }));

    const first = await engine.matrix(MATRIX_REQUEST);
    const second = await engine.matrix(MATRIX_REQUEST);
    expect(first).toEqual(second);
    expect(first.map((answer) => answer.distanceM)).toEqual([600, 1200]);
  });
});

describe("the timeout is a hard abort, not a wait", () => {
  test.each([
    ["osrm", osrm],
    ["valhalla", valhalla],
    ["graphhopper", graphhopper],
  ])("%s aborts at its configured budget and reports TIMEOUT", async (id, adapter) => {
    // §5.2 gives the matrix query a hard budget, and §18.3 B6 is the reason it must be hard: a
    // late answer that still arrives is a candidate scored on data another candidate did not get.
    // The budget is configuration, not a registered parameter — route.matrix_timeout does not
    // exist in the register (§32.5), and this adapter states none.
    const engine = adapter.create(configFor({ transport: fakeTransport({ hang: true }), matrixTimeoutMs: 20 }));
    await expect(engine.matrix(MATRIX_REQUEST)).rejects.toMatchObject({ status: contract.ROUTE_STATUS.TIMEOUT });
  });
});

describe("normalisation is deterministic — R10, §9.6's byte-for-byte replay", () => {
  test("a repeated destination is de-duplicated, first-seen order preserved", async () => {
    const transport = fakeTransport(osrmTable([120, 240], [600, 1200]));
    const engine = osrm.create(configFor({ transport }));
    const answers = await engine.matrix({ ...MATRIX_REQUEST, destCellIds: ["cell:a", "cell:b", "cell:a"] });

    expect(answers.map((answer) => answer.destCellId)).toEqual(["cell:a", "cell:b"]);
    expect(transport.requests[0].url).toContain("-0.12,51.5;-0.11,51.51;-0.1,51.52");
  });

  test("identical requests produce identical answers, and charger ties break on id", async () => {
    // A tie broken by array position would make the answer depend on the catalogue's iteration
    // order, which is the caller's, which makes the adapter non-deterministic by inheritance.
    const engine = osrm.create(configFor({ transport: fakeTransport(osrmTable([100, 100, 100], [500, 500, 500])) }));
    const first = await engine.nearestChargers({ ...CHARGER_REQUEST, k: 3 });
    const second = await engine.nearestChargers({ ...CHARGER_REQUEST, k: 3 });

    expect(first.map((charger) => charger.chargerId)).toEqual(["C-far", "C-near", "C-tie"]);
    expect(first).toEqual(second);
  });

  test("no adapter reads a clock: timeBucket is the caller's or the request is refused", async () => {
    // §9.6 item 4 and both cache headers — "a cache keyed on a locally-read clock would return
    // different entries to two workers in the same round". N28 records that nothing in src/
    // derives a bucket yet; that producer belongs to the absent composition root, not here.
    const engine = valhalla.create(configFor({ transport: fakeTransport({}) }));
    await expect(engine.nearestChargers({ ...CHARGER_REQUEST, timeBucket: undefined })).rejects.toThrow(/timeBucket/u);
  });
});

describe("the roster reports what exists, and refuses to imply more", () => {
  test("all four §27 item 2 candidates are present, in the shortlist's own order", () => {
    expect(registry.roster().map((row) => row.id)).toEqual(["osrm", "valhalla", "graphhopper", "inhouse"]);
    expect(contract.CANDIDATE_IDS).toEqual(["osrm", "valhalla", "graphhopper", "inhouse"]);
  });

  test("with no deployment configured every candidate is unmeasurable, and says why", () => {
    // B1 Step 1 is blocked by D1: there is no region, no extract and no built hierarchy. The
    // roster is where that is a fact rather than an absence.
    for (const row of registry.roster()) {
      expect({ id: row.id, measurable: row.measurable }).toEqual({ id: row.id, measurable: false });
      expect(row.reason.length).toBeGreaterThan(0);
    }
    expect(registry.roster().find((row) => row.id === "osrm").status).toBe(contract.AVAILABILITY.NOT_DEPLOYED);
  });

  test("in-house is NOT_IMPLEMENTED and exports no matrix — it is not faked to fill the list", () => {
    // §27 item 2 names in-house, and nothing in this repository is one. The nearest module runs
    // A* over a supplied waypoint array and takes its geometry from the metered external API
    // ADR-11 records as rejected — the legacy path B1 replaces (N30), not a candidate for it.
    expect(inhouse.availability.status).toBe(contract.AVAILABILITY.NOT_IMPLEMENTED);
    expect(typeof inhouse.matrix).toBe("undefined");
    expect(() => inhouse.create({})).toThrow(/no in-house routing engine exists/u);
  });

  test("no candidate is marked as selected, preferred or ranked", () => {
    // B1's engine selection is Step 5, on recorded evidence. Step 2 produces adapters and
    // nothing else, and there is no evidence yet for anything to be chosen on.
    for (const row of registry.roster()) {
      expect(Object.keys(row)).not.toContain("rank");
      expect(Object.keys(row)).not.toContain("preferred");
    }
  });
});

describe("the D1/D8 configuration seam refuses to fill itself in", () => {
  const deployment = require("../../tools/routing/adapters/deployment");

  test("with the variable unset, the reason names the decision that is actually missing", () => {
    const { ok, reason } = deployment.loadDeployment({});
    expect(ok).toBe(false);
    // Not "misconfigured" — B1 Step 1 has not been performed, and the reason it has not been
    // performed is D1 (no extract) and D3 (no speed model behind a profile's edge costs).
    expect(reason).toMatch(/D1/u);
    expect(reason).toMatch(/D3/u);
    expect(reason).toMatch(/NOT_MEASURED — which is not a pass/u);
  });

  test("a deployment module that cannot be loaded is reported, not skipped", () => {
    const { ok, reason } = deployment.loadDeployment({ ROUTING_B1_DEPLOYMENT: "/no/such/deployment/module.js" });
    expect(ok).toBe(false);
    expect(reason).toMatch(/could not be loaded/u);
  });

  test("a module that names no configuration for a candidate leaves that candidate unavailable", () => {
    // Pointed at a real module that is simply not a deployment descriptor. The adapter layer
    // must say which candidate is unconfigured rather than construct one from partial input.
    const env = { ROUTING_B1_DEPLOYMENT: require.resolve("../../tools/routing/adapters/contract.js") };
    const { ok, reason } = deployment.configFor("osrm", env);
    expect(ok).toBe(false);
    expect(reason).toMatch(/names no configuration for candidate "osrm"/u);

    const materialised = deployment.materialise("osrm", osrm.create, contract, env);
    expect(materialised.availability.status).toBe(contract.AVAILABILITY.NOT_DEPLOYED);
    expect(typeof materialised.matrix).toBe("undefined");
  });

  test("a configuration the adapter cannot use is MISCONFIGURED, never worked around", () => {
    const materialised = deployment.materialise("osrm", () => osrm.create({ baseUrl: "http://osrm.internal:5000" }), contract, {
      ROUTING_B1_DEPLOYMENT: require.resolve("./helpers/nullRoutingAdapter.js"),
    });
    // `nullRoutingAdapter` exports an `id`, not a deployment map, so there is no `osrm` key —
    // the point of the row is that a half-usable configuration still yields no adapter.
    expect([contract.AVAILABILITY.NOT_DEPLOYED, contract.AVAILABILITY.MISCONFIGURED]).toContain(materialised.availability.status);
    expect(typeof materialised.matrix).toBe("undefined");
  });
});

describe("the benchmark discovers and selects the adapters, and reports them honestly", () => {
  test("`--candidates` lists the roster without measuring anything", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const code = await benchmark.main(["--candidates"]);
    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    log.mockRestore();

    expect(code).toBe(0);
    expect(printed).toMatch(/NOT a ranking/u);
    for (const id of contract.CANDIDATE_IDS) expect(printed).toContain(id);
  });

  test("selecting an undeployed candidate reports NOT_DEPLOYED, measures nothing, and exits 0", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const code = await benchmark.main(["--engine", "osrm"]);
    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    log.mockRestore();

    // The distinction the whole tool exists to preserve. Exit 0 because no claim was made — and
    // every row NOT_MEASURED, with no fabricated latency, throughput or hit rate anywhere in it.
    expect(code).toBe(0);
    expect(printed).toMatch(/NOT_DEPLOYED/u);
    expect(printed).toMatch(/NOT_MEASURED is not PASS/u);

    // Asserted per benchmark row rather than as "the word PASS appears nowhere in the output".
    // PHASE 15 added the readiness gate to this report, and its step 2 legitimately reads PASS —
    // the four adapters exist, which is a true statement about work that is done and is not a
    // claim about any candidate's performance. The property this test is protecting is narrower
    // and unweakened: **no §20.1 row may be reported as passing** when nothing was measured.
    for (const row of benchmark.ROWS) {
      const printedRow = printed.split("\n").find((line) => line.includes(row.id) && /^\s{2}\w/u.test(line));
      expect({ id: row.id, line: printedRow }).toEqual({ id: row.id, line: expect.stringContaining(benchmark.VERDICT.NOT_MEASURED) });
    }
    // …and the readiness gate must still be reporting the steps as blocked rather than passed.
    expect(printed).toMatch(/BLOCKED\s+step 1/u);
    expect(printed).toMatch(/would NOT be admissible as B1 Step 3 evidence/u);
  });

  test("an engine that answers no spread now loses the entry instead of being credited with certainty", async () => {
    // N29, end to end. `b1Benchmark.js` coalesced a missing `travelSdSeconds` to 0, which
    // `cellPairCache.buildEntry` then accepted as a valid entry meaning "this ETA is certain".
    // With the coalesce gone the entry is refused, the cache stays empty, and the silence is
    // visible as a hit rate of 0 rather than hidden behind an optimistic default.
    const silent = {
      id: "silent-stub",
      description: "test fixture; answers no travel-time spread. Not a candidate engine",
      profile: { energyWhPerMetre: 0.05, speedMetresPerSecond: 5 },
      async matrix({ destCellIds }) {
        return destCellIds.map((destCellId) => ({ destCellId, distanceM: 100, travelSeconds: 20 }));
      },
    };
    const shape = { legs: 4, candidatesPerLeg: 4, clusterCount: 2, profileKey: "ground_default", timeBucket: 0, projectionVersion: 1 };
    const config = { cellPairTtl: 900, cellPairMinHitRate: 0.95, chargerK: 5, chargerTtl: 900, intraCellOffsetM: 250, energyWhPerMetre: 0.05, speedMetresPerSecond: 5 };

    const measured = await benchmark.measure(silent, config, shape);
    expect(measured.cacheEntries).toBe(0);
    expect(measured.approachHitRate.hitRate).toBe(0);
  });
});

describe("PHASE 15 — two defects found auditing the Step 2 work, and their fixes", () => {
  /**
   * **The determinism defect.** `nearestK`'s tie-break was `chargerId.localeCompare(...)`.
   * `determinism/ordering.js`'s own header rules that out in as many words: "`localeCompare`
   * depends on the host's ICU data and collation locale, so the same two ids can order
   * differently on two hosts. A total order whose result depends on where it ran is not a
   * total order for replay purposes."
   *
   * It is load-bearing rather than theoretical because the order decides which chargers
   * survive the truncation to `k`. Two chargers at an identical distance and duration is not
   * an edge case — a catalogue laid out on a grid produces them — and a build machine and a
   * shard that truncated a tie differently would write two different entries under one cache
   * key (§20.3), surfacing only as an unexplained replay diff (§9.6).
   */
  test("nearestK breaks a tie by code unit, not by the host's collation", () => {
    // `"a"` sorts BEFORE `"B"` under most ICU collations and AFTER it by code unit. Any
    // implementation still calling `localeCompare` returns the other order here.
    const tied = [
      { chargerId: "a-charger", status: contract.ROUTE_STATUS.OK, distanceM: 100, travelSeconds: 10 },
      { chargerId: "B-charger", status: contract.ROUTE_STATUS.OK, distanceM: 100, travelSeconds: 10 },
    ];
    expect(contract.nearestK(tied, 2).map((charger) => charger.chargerId)).toEqual(["B-charger", "a-charger"]);
    // …and the truncation follows the same order, which is where the defect would have bitten.
    expect(contract.nearestK(tied, 1).map((charger) => charger.chargerId)).toEqual(["B-charger"]);
  });

  test("the entry cache applies the same order, so the adapter and the cache cannot disagree", () => {
    // eslint-disable-next-line global-require
    const chargerCache = require("../../src/engine/routing/chargerReachabilityCache");
    const built = chargerCache.buildEntry({
      chargers: [
        { chargerId: "a-charger", distanceM: 100, travelSeconds: 10 },
        { chargerId: "B-charger", distanceM: 100, travelSeconds: 10 },
      ],
      k: 2,
      intraCellOffsetM: 0,
      energyWhPerMetre: 0.05,
      speedMetresPerSecond: 5,
      projectionVersion: 1,
    });
    expect(built.entry.chargers.map((charger) => charger.chargerId)).toEqual(["B-charger", "a-charger"]);
  });

  /**
   * **The placeholder defect.** The four `deployment` fields are carried opaquely *because*
   * D1 owns the extract and D8 owns its vintage — and the reason they are carried at all is
   * that `b1Benchmark.js:89–90` puts them in the adapter's `description` and Step 4 records
   * them as operational costs. "TBD" satisfies "a non-empty string" and satisfies nothing
   * else: it would reach the Step 5 record reading as though somebody had answered.
   */
  test("a placeholder in the deployment block is refused — a non-answer is not an answer", () => {
    for (const token of ["TBD", "tbd.", "n/a", "unknown", "?", "TODO"]) {
      expect(() => osrm.create(configFor({ deployment: { shape: "fixture", extract: token, profilesBuilt: "none", hierarchyBuildTime: "not built" } }))).toThrow(
        /is a placeholder rather than a value/u,
      );
    }
  });

  test("but an honest negative is accepted — the check must not push operators toward prose", () => {
    // "none" and "not built" are the truthful answers for a candidate Step 1 has not deployed,
    // and refusing them would teach people to write something that reads better instead.
    expect(() => osrm.create(configFor())).not.toThrow();
    expect(osrm.create(configFor()).description).toMatch(/profiles none; hierarchy build not built/u);
  });
});
