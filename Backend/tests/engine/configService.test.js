"use strict";

/**
 * Engine lane — the Config Service's publish, pin and load path (§22.1, §22.3, §3.3).
 */

const service = require("../../src/engine/config/service");

const bind = (name, value, level = "global", key = "") => ({ level, key, name, value });

/** The baseline that passes every blocking check — see `configValidators.test.js`. */
const BASELINE = [bind("energy.max_combined_conservatism", 2.1)];

/**
 * An in-memory stand-in for the config tables. Deliberately not the shared
 * `mockPrisma` helper: that one belongs to the legacy lane, and the engine lane must
 * not acquire a dependency on it.
 */
function createConfigStore() {
  const versions = [];
  const bindings = [];
  let pin = null;
  let identity = 0;

  const client = {
    configVersion: {
      create: jest.fn(async ({ data }) => {
        identity += 1;
        const row = { id: `cv-${identity}`, publishedAt: new Date("2026-07-28T09:00:00Z"), ...data };
        versions.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ orderBy }) => {
        if (versions.length === 0) return null;
        const sorted = [...versions].sort((a, b) => (orderBy?.version === "desc" ? b.version - a.version : a.version - b.version));
        return sorted[0];
      }),
      findUnique: jest.fn(async ({ where }) => versions.find((row) => row.version === where.version) || null),
      findMany: jest.fn(async () => [...versions].sort((a, b) => b.version - a.version)),
    },
    configScopeBinding: {
      createMany: jest.fn(async ({ data }) => {
        bindings.push(...data);
        return { count: data.length };
      }),
    },
    configActiveVersion: {
      upsert: jest.fn(async ({ create, update }) => {
        pin = pin ? { ...pin, ...update } : { ...create };
        return pin;
      }),
      findUnique: jest.fn(async () => pin),
    },
    parameterRegisterEntry: {
      upsert: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (callback) => callback(client)),
  };

  return { client, versions, bindings, get pin() { return pin; } };
}

/**
 * Assert a publish was refused, and that one of its findings says why. The thrown
 * message is a summary; the findings are the contract, because an operator needs to
 * know *which* rule rejected them, not that something did.
 */
async function expectRefused(promise, pattern) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).not.toBeNull();
  expect(error.name).toBe("ConfigValidationError");
  expect(error.findings.map((item) => item.message).join("\n")).toMatch(pattern);
  return error;
}

/** A minimal KV double with the two methods the service uses. */
function createKv() {
  const store = new Map();
  return {
    store,
    get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key, value) => {
      store.set(key, value);
      return "OK";
    }),
  };
}

describe("publish", () => {
  test("refuses an invalid configuration and names the rules that rejected it", async () => {
    const { client } = createConfigStore();
    await expect(
      service.publish(client, { publishedBy: "ops-1", bindings: [...BASELINE, bind("agent.dedup_retention", 5)] }),
    ).rejects.toMatchObject({ name: "ConfigValidationError" });

    try {
      await service.publish(client, { publishedBy: "ops-1", bindings: [...BASELINE, bind("agent.dedup_retention", 5)] });
    } catch (error) {
      expect(error.findings.some((item) => item.id === "V5")).toBe(true);
      expect(error.message).toMatch(/rejected at publish time/);
    }
    expect(client.configVersion.create).not.toHaveBeenCalled();
  });

  test("writes an immutable version carrying a content signature over its payload", async () => {
    const { client, versions } = createConfigStore();
    const published = await service.publish(client, { publishedBy: "ops-1", bindings: BASELINE, approvals: [{ approverId: "safety-1", approvedAt: "2026-07-28T09:00:00Z" }] });

    expect(published.version).toBe(1);
    expect(published.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[0].payload.values["energy.max_combined_conservatism"]).toBe(2.1);
    expect(versions[0].payload.registerDigest).toBe(service.registerDigest(service.loadRegister().entries));
  });

  test("the signature is a function of content, not of publish order", async () => {
    const first = createConfigStore();
    const second = createConfigStore();
    const a = await service.publish(first.client, {
      publishedBy: "ops-1",
      bindings: BASELINE,
      approvals: [{ approverId: "safety-1", approvedAt: "t" }],
    });
    const b = await service.publish(second.client, {
      publishedBy: "ops-2",
      bindings: BASELINE,
      approvals: [{ approverId: "safety-2", approvedAt: "t" }],
    });
    expect(a.signature).toBe(b.signature);
  });

  test("versions are monotone", async () => {
    const { client } = createConfigStore();
    const approvals = [{ approverId: "safety-1", approvedAt: "t" }];
    const first = await service.publish(client, { publishedBy: "ops-1", bindings: BASELINE, approvals });
    const second = await service.publish(client, {
      publishedBy: "ops-1",
      bindings: [...BASELINE, bind("solve.window_min", 600)],
      approvals,
    });
    expect([first.version, second.version]).toEqual([1, 2]);
  });

  test("records the scope bindings alongside the payload, so resolution is queryable per version", async () => {
    const store = createConfigStore();
    await service.publish(store.client, {
      publishedBy: "ops-1",
      bindings: [...BASELINE, bind("verify.arrival_radius", 8, "site", "depot-3")],
      approvals: [{ approverId: "safety-1", approvedAt: "t" }],
    });
    expect(store.bindings).toContainEqual(
      expect.objectContaining({ parameterName: "verify.arrival_radius", scopeLevel: "site", scopeKey: "depot-3" }),
    );
  });

  test("carries the §22.4 launch-gate findings so the Phase 15 gate is a report, not a discovery", async () => {
    const { client, versions } = createConfigStore();
    await service.publish(client, {
      publishedBy: "ops-1",
      bindings: BASELINE,
      approvals: [{ approverId: "safety-1", approvedAt: "t" }],
    });
    expect(versions[0].launchGateFindings.length).toBeGreaterThan(0);
  });
});

describe("§22.3 — Safety-class changes", () => {
  const safetyChange = [...BASELINE, bind("lease.duration", 90)];

  test("are identified by change class and by an actual change of value", () => {
    const entries = service.loadRegister().entries;
    const before = service.buildSnapshot({ bindings: BASELINE });
    const after = service.buildSnapshot({ bindings: safetyChange });
    const previous = Object.fromEntries(before.values.entries());

    expect(service.safetyClassChanges(entries, after.values, previous)).toEqual(["lease.duration"]);

    // A Tuned-only publish changes no Safety-class value, so it needs no approval.
    const tuned = service.buildSnapshot({ bindings: [...BASELINE, bind("solve.window_min", 600)] });
    expect(service.safetyClassChanges(entries, tuned.values, previous)).toEqual([]);

    // The first publish establishes every Safety-class value, so all of them count.
    expect(service.safetyClassChanges(entries, after.values, null).length).toBeGreaterThan(10);
  });

  test("require two distinct people", async () => {
    const { client } = createConfigStore();
    await expect(
      service.publish(client, { publishedBy: "ops-1", bindings: safetyChange, approvals: [] }),
    ).rejects.toMatchObject({ name: "ConfigValidationError" });

    await expectRefused(
      service.publish(client, {
        publishedBy: "ops-1",
        bindings: safetyChange,
        approvals: [{ approverId: "ops-1", approvedAt: "t" }],
      }),
      /two-person approval requires 2/,
    );

    const published = await service.publish(client, {
      publishedBy: "ops-1",
      bindings: safetyChange,
      approvals: [{ approverId: "safety-1", approvedAt: "t" }],
    });
    expect(published.version).toBe(1);
  });

  test("every approval records who gave it and when", () => {
    const findings = service.checkSafetyApproval(
      { publishedBy: "ops-1", approvals: [{ approverId: "safety-1" }] },
      ["lease.duration"],
    );
    expect(findings.some((item) => item.id === "S3")).toBe(true);
  });

  test("may never be made by an automated process — an absolute rule", async () => {
    const { client } = createConfigStore();
    await expectRefused(
      service.publish(client, {
        publishedBy: "tuner",
        automated: true,
        bindings: safetyChange,
        approvals: [{ approverId: "safety-1", approvedAt: "t" }, { approverId: "safety-2", approvedAt: "t" }],
      }),
      /No automated tuner may modify a Safety-class parameter/,
    );
  });

  test("an automated publish that touches no Safety-class parameter is allowed", async () => {
    const { client } = createConfigStore();
    // The baseline binding is itself Safety-class, so it is published first by a
    // human; the automated publish then changes only a Tuned parameter.
    await service.publish(client, {
      publishedBy: "ops-1",
      bindings: BASELINE,
      approvals: [{ approverId: "safety-1", approvedAt: "t" }],
    });
    const published = await service.publish(client, {
      publishedBy: "tuner",
      automated: true,
      bindings: [...BASELINE, bind("solve.window_min", 600)],
    });
    expect(published.version).toBe(2);
    expect(published.safetyClassChanges).toEqual([]);
  });
});

describe("pin and load — cache-read, DB-authoritative (§3.3)", () => {
  async function publishAndPin() {
    const store = createConfigStore();
    const kv = createKv();
    const published = await service.publish(store.client, {
      publishedBy: "ops-1",
      bindings: [...BASELINE, bind("solve.window_min", 750)],
      approvals: [{ approverId: "safety-1", approvedAt: "t" }],
    });
    await service.pinVersion(store.client, kv, published.version, "ops-1");
    return { store, kv, published };
  }

  test("pinning mirrors the pointer and the materialised set into the cache", async () => {
    const { kv } = await publishAndPin();
    expect(kv.store.get(service.ACTIVE_VERSION_KEY)).toBe("1");
    expect(kv.store.has("config:v:1")).toBe(true);
  });

  test("loading returns a snapshot that resolves the published bindings", async () => {
    const { store, kv } = await publishAndPin();
    const snapshot = await service.loadPinnedSnapshot({ prisma: store.client, kv });
    expect(snapshot.version).toBe(1);
    expect(snapshot.resolve("solve.window_min")).toBe(750);
    expect(snapshot.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a flushed cache costs a query, never a wrong answer", async () => {
    const { store, kv } = await publishAndPin();
    kv.store.clear();
    const snapshot = await service.loadPinnedSnapshot({ prisma: store.client, kv });
    expect(snapshot.version).toBe(1);
    expect(snapshot.resolve("solve.window_min")).toBe(750);
    expect(store.client.configActiveVersion.findUnique).toHaveBeenCalled();
  });

  test("no cache at all is a supported configuration", async () => {
    const { store } = await publishAndPin();
    const snapshot = await service.loadPinnedSnapshot({ prisma: store.client, kv: null });
    expect(snapshot.version).toBe(1);
  });

  test("pinning a version that does not exist is refused", async () => {
    const { client } = createConfigStore();
    await expect(service.pinVersion(client, null, 9, "ops-1")).rejects.toThrow(/does not exist/);
  });

  test("nothing published yet resolves to null rather than to an invented version", async () => {
    const { client } = createConfigStore();
    expect(await service.loadPinnedSnapshot({ prisma: client, kv: createKv() })).toBeNull();
  });
});

describe("bootstrap", () => {
  test("falls back to register defaults while the engine is off", async () => {
    const { client } = createConfigStore();
    const snapshot = await service.bootstrap({ prisma: client, kv: null, engineEnabled: false });
    expect(snapshot.version).toBeNull();
    expect(snapshot.resolve("solve.window_min")).toBe(500);
  });

  test("refuses to start on defaults when the engine claims to be running", async () => {
    const { client } = createConfigStore();
    await expect(service.bootstrap({ prisma: client, kv: null, engineEnabled: true })).rejects.toThrow(
      /partial application that rule prohibits/,
    );
  });

  test("loads the pinned version when one exists", async () => {
    const store = createConfigStore();
    const kv = createKv();
    const published = await service.publish(store.client, {
      publishedBy: "ops-1",
      bindings: BASELINE,
      approvals: [{ approverId: "safety-1", approvedAt: "t" }],
    });
    await service.pinVersion(store.client, kv, published.version, "ops-1");

    const snapshot = await service.bootstrap({ prisma: store.client, kv, engineEnabled: true });
    expect(snapshot.version).toBe(1);
  });

  test("works with no database at all — the register defaults need neither store", async () => {
    const snapshot = await service.bootstrap({ engineEnabled: false });
    expect(snapshot.entries.size).toBeGreaterThan(100);
  });
});

describe("register mirroring", () => {
  test("seeds one ParameterRegisterEntry row per entry, idempotently", async () => {
    const { client } = createConfigStore();
    const first = await service.seedRegister(client);
    const second = await service.seedRegister(client);
    expect(first.seeded).toBe(service.loadRegister().entries.size);
    expect(second.seeded).toBe(first.seeded);
    expect(client.parameterRegisterEntry.upsert).toHaveBeenCalledTimes(first.seeded * 2);
  });
});
