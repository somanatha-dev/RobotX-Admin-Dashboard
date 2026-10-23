"use strict";

/**
 * The approved publication guard (owner decision 2026-10-23), focused: `POST /api/config/publish`
 * refuses a spatial map whose zone references the `Zone` table does not hold — before publishing,
 * so nothing is written and the pin does not move — and changes nothing else:
 *
 *   · today's one-zone map (rnsit-z1, a Zone row in its region) still publishes and pins;
 *   · an unpinned candidate (`pin: false`) is guarded too;
 *   · a failed guard read publishes nothing (the error goes to `next`);
 *   · the Config Service's own validation refusal is returned exactly as before;
 *   · authorisation still runs first: the route's middleware chain is unchanged.
 */

jest.mock("../../../src/db/prisma", () => ({ getPrisma: jest.fn() }));

const { getPrisma } = require("../../../src/db/prisma");
const configService = require("../../../src/engine/config/service");
const configController = require("../../../src/controllers/config.controller");

const REGION = "row-rnsit";
const oneZoneMap = () => ({
  version: 1,
  regions: [{ id: REGION }],
  zones: [{ id: "rnsit-z1", regionId: REGION }],
  sites: [],
  cells: [{ cellId: "8b6014510498fff", resolution: "FINE", regionId: REGION, zoneId: "rnsit-z1" }],
});
const g4Map = () => ({
  ...oneZoneMap(),
  zones: ["rnsit-z-west", "rnsit-z-east"].map((id) => ({ id, regionId: REGION })),
  cells: [
    { cellId: "8b601451284cfff", resolution: "FINE", regionId: REGION, zoneId: "rnsit-z-west" },
    { cellId: "8b6014512865fff", resolution: "FINE", regionId: REGION, zoneId: "rnsit-z-east" },
  ],
});
function prismaWith(rows, { fail = false } = {}) {
  return {
    zone: {
      findMany: jest.fn(async (args) => {
        if (fail) throw new Error("connection reset");
        return rows.filter((r) => args.where.id.in.includes(r.id)).map((r) => ({ id: r.id, regionId: r.regionId }));
      }),
    },
  };
}
async function call(prisma, body) {
  getPrisma.mockReturnValue(prisma);
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; done(); return this; } };
  const next = jest.fn(() => done());
  configController.publishVersion({ body, user: { id: "operator-1" }, app: { locals: { kv: null } } }, res, next);
  await finished;
  return { res, next };
}

let publish;
let pin;
beforeEach(() => {
  publish = jest.spyOn(configService, "publish").mockResolvedValue({ version: 9, signature: "s", publishedAt: new Date(0), safetyClassChanges: [], launchGate: [], findings: [] });
  pin = jest.spyOn(configService, "pinVersion").mockResolvedValue({ version: 9 });
});
afterEach(() => jest.restoreAllMocks());

test("today's one-zone map (its Zone row in its region) publishes and pins exactly as before", async () => {
  const { res } = await call(prismaWith([{ id: "rnsit-z1", regionId: REGION }]), { spatial: oneZoneMap(), bindings: [] });
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ ok: true, version: 9, pinned: true });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(pin).toHaveBeenCalledTimes(1);
});

test("missing Zone rows: 422 naming each, nothing published or pinned", async () => {
  const { res, next } = await call(prismaWith([{ id: "rnsit-z1", regionId: REGION }]), { spatial: g4Map(), bindings: [] });
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(422);
  expect(res.body.message).toMatch(/nothing was published or pinned/);
  expect(res.body.findings.map((f) => f.message)).toEqual([
    'no Zone row "rnsit-z-west": F27 would refuse every route through it',
    'no Zone row "rnsit-z-east": F27 would refuse every route through it',
  ]);
  expect(publish).not.toHaveBeenCalled();
  expect(pin).not.toHaveBeenCalled();
});

test("a Zone row in another region is refused the same way", async () => {
  const rows = [{ id: "rnsit-z-west", regionId: REGION }, { id: "rnsit-z-east", regionId: "row-elsewhere" }];
  const { res } = await call(prismaWith(rows), { spatial: g4Map(), bindings: [] });
  expect(res.statusCode).toBe(422);
  expect(res.body.findings).toEqual([expect.objectContaining({ id: "ZONE_REFERENCE", message: expect.stringMatching(/rnsit-z-east" is in region row-elsewhere/) })]);
  expect(publish).not.toHaveBeenCalled();
});

test("an unpinned candidate (pin: false) is guarded too", async () => {
  const { res } = await call(prismaWith([]), { spatial: g4Map(), bindings: [], pin: false });
  expect(res.statusCode).toBe(422);
  expect(publish).not.toHaveBeenCalled();
  expect(pin).not.toHaveBeenCalled();
});

test("a failed guard read publishes nothing: the error goes to next(), no partial write", async () => {
  const { res, next } = await call(prismaWith([], { fail: true }), { spatial: g4Map(), bindings: [] });
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "connection reset" }));
  expect(res.body).toBeNull();
  expect(publish).not.toHaveBeenCalled();
  expect(pin).not.toHaveBeenCalled();
});

test("the Config Service's own validation refusal is returned as before (guard passed, publish refuses)", async () => {
  publish.mockRejectedValue(new configService.ConfigValidationError("configuration rejected at publish time: 1 blocking finding(s).", [{ id: "V8", severity: "BLOCKING", message: "x" }]));
  const { res } = await call(prismaWith([{ id: "rnsit-z1", regionId: REGION }]), { spatial: oneZoneMap(), bindings: [] });
  expect(res.statusCode).toBe(422);
  expect(res.body).toEqual({ ok: false, message: "configuration rejected at publish time: 1 blocking finding(s).", findings: [{ id: "V8", severity: "BLOCKING", message: "x" }] });
  expect(pin).not.toHaveBeenCalled();
});

test("authorisation still runs first: the publish route's middleware chain is unchanged", () => {
  const router = require("../../../src/routes/config.routes");
  const layers = router.stack.map((l) => (l.route ? `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path} [${l.route.stack.map((s) => s.name).join(", ")}]` : l.name));
  const publishLayer = layers.find((l) => l.startsWith("POST /publish"));
  // router.use(authUser), requireElevatedRole(), requireSuperAdmin() precede every route.
  expect(layers.indexOf(publishLayer)).toBeGreaterThanOrEqual(3);
  expect(layers.slice(0, 3)).toEqual(["authUser", expect.any(String), expect.any(String)]);
  // rate limit → action-class gate (second approver) → controller.
  expect(publishLayer).toMatch(/\[.*actionClassGate, asyncMiddleware\]$/);
});
