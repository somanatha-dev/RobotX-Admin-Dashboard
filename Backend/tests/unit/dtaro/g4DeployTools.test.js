"use strict";

/**
 * The two G4 operator tools refuse before connecting when the target is not named twice, and the
 * Zone-row plan creates only what is missing and refuses anything that exists differently.
 */

const { planRows, run: createRows } = require("../../../tools/deploy/createG4ZoneRows");
const { run: publish, diagnoseLogin, parameterChanges, servedPolicyNeedsApprover } = require("../../../tools/deploy/publishG4");

const wanted = [
  { id: "rnsit-z-west", name: "RNSIT West — x", regionId: "r1" },
  { id: "rnsit-z-east", name: "RNSIT East — y", regionId: "r1" },
];
const index = (rows) => [new Map(rows.map((r) => [r.id, r])), new Map(rows.map((r) => [r.name, r]))];

test("plan: creates only missing rows; an identical row is UNCHANGED", () => {
  const plan = planRows(wanted, ...index([{ id: "rnsit-z-west", name: "RNSIT West — x", regionId: "r1" }, { id: "rnsit-z1", name: "RNSIT Zone 1", regionId: "r1" }]));
  expect(plan.map((p) => `${p.id}:${p.action}`)).toEqual(["rnsit-z-west:UNCHANGED", "rnsit-z-east:CREATE"]);
});

test("plan: a row with the same id in another region, or a taken name, is a CONFLICT", () => {
  expect(planRows(wanted, ...index([{ id: "rnsit-z-west", name: "RNSIT West — x", regionId: "r2" }]))[0]).toMatchObject({ action: "CONFLICT" });
  expect(planRows(wanted, ...index([{ id: "legacy", name: "RNSIT East — y", regionId: null }]))[1]).toMatchObject({ action: "CONFLICT", reason: expect.stringMatching(/already Zone legacy/) });
});

test("both tools refuse before connecting unless the database host is repeated exactly", async () => {
  const url = "postgresql://u@ep-example.neon.tech/neondb";
  await expect(createRows({ url, confirmHost: "ep-other.neon.tech", apply: true })).rejects.toThrow(/--confirm-host must repeat the database host exactly/);
  await expect(createRows({ url, confirmHost: null, apply: false })).rejects.toThrow(/--confirm-host/);
  const args = { api: "https://api.example", url, confirmHost: "wrong", email: "a@b", reason: "r", expectActive: 1, apply: true };
  await expect(publish(args)).rejects.toThrow(/--confirm-host must repeat/);
  await expect(publish({ ...args, confirmHost: "ep-example.neon.tech", reason: null })).rejects.toThrow(/--reason is required/);
  await expect(publish({ ...args, confirmHost: "ep-example.neon.tech", email: null })).rejects.toThrow(/--email is required/);
  await expect(publish({ ...args, confirmHost: "ep-example.neon.tech", api: "ftp://x" })).rejects.toThrow(/--api must be an http/);
});


describe("login diagnosis (read only; never reads the password value)", () => {
  const prismaReturning = (rows) => {
    const calls = [];
    const tx = {
      $executeRawUnsafe: async (q) => { calls.push(q); },
      $queryRawUnsafe: async (q, email) => { calls.push({ q, email }); return rows; },
    };
    return { calls, $transaction: async (fn) => fn(tx) };
  };
  const row = (over) => ({ role: "SUPER_ADMIN", exact: true, disabled: false, google_linked: false, password_login: true, ...over });

  test.each([
    ["no account", [], "NO_ACCOUNT"],
    ["case/space mismatch", [row({ exact: false })], "EMAIL_MISMATCH"],
    ["disabled", [row({ disabled: true })], "DISABLED"],
    ["Google sign-in only (non-bcrypt placeholder)", [row({ password_login: false, google_linked: true })], "GOOGLE_ONLY"],
    ["not a SUPER_ADMIN", [row({ role: "ADMIN" })], "NOT_SUPER_ADMIN"],
    ["password account", [row({})], "WRONG_PASSWORD"],
  ])("%s → %s", async (_name, rows, verdict) => {
    const prisma = prismaReturning(rows);
    const result = await diagnoseLogin(prisma, "owner@example.com");
    expect(result.verdict).toBe(verdict);
    expect(prisma.calls[0]).toBe("SET TRANSACTION READ ONLY");
    // The password column is read only inside left(…, 4) and length(…), which yield booleans: its
    // value is never selected.
    expect(prisma.calls[1].q.replace(/left\(password, 4\)|length\(password\)|password_login/g, "")).not.toMatch(/\bpassword\b/);
    expect(prisma.calls[1].email).toBe("owner@example.com");
  });
});

describe("no second approver (owner decision 2026-10-23)", () => {
  test("the tool takes no --second-approver: a run without one is not refused for it", async () => {
    const args = { api: "https://api.example", url: "postgresql://u@ep-example.neon.tech/neondb", confirmHost: "wrong", email: "a@b", reason: "r", expectActive: 1, apply: true };
    await expect(publish(args)).rejects.toThrow(/--confirm-host must repeat/);
    await expect(publish(args)).rejects.not.toThrow(/approver/);
  });

  test.each([
    ["the 2026-10-23 default", { ok: true, resolution: { value: ["QUARANTINE_OVERRIDE"] } }, false],
    ["an older deployment (both classes)", { ok: true, resolution: { value: ["QUARANTINE_OVERRIDE", "SAFETY_CONFIG_CHANGE"] } }, true],
    ["re-enabled by configuration", { ok: true, resolution: { value: ["SAFETY_CONFIG_CHANGE"] } }, true],
    ["an unreadable answer", null, true],
  ])("served policy: %s → needs approver %s", (_name, body, expected) => {
    expect(servedPolicyNeedsApprover(body)).toBe(expected);
  });
});

describe("parameter comparison (the publish may change the map and nothing else)", () => {
  test("identical value maps report no change, whether Maps or plain objects", () => {
    expect(parameterChanges(new Map([["a", 1], ["b", [1, 2]]]), { a: 1, b: [1, 2] })).toEqual([]);
  });
  test("a changed, added or removed value is named", () => {
    expect(parameterChanges({ a: 1, b: [1], c: 3 }, { a: 2, b: [1], d: 4 })).toEqual(["a", "c", "d"]);
  });
  test("null and absent are the same (an unset value)", () => {
    expect(parameterChanges({ a: null }, {})).toEqual([]);
  });
});
