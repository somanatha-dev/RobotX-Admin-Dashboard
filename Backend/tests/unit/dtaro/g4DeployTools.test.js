"use strict";

/**
 * The two G4 operator tools refuse before connecting when the target is not named twice, and the
 * Zone-row plan creates only what is missing and refuses anything that exists differently.
 */

const { planRows, run: createRows } = require("../../../tools/deploy/createG4ZoneRows");
const { run: publish } = require("../../../tools/deploy/publishG4");

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
  const args = { api: "https://api.example", url, confirmHost: "wrong", email: "a@b", secondApproverId: "x", reason: "r", expectActive: 1, apply: true };
  await expect(publish(args)).rejects.toThrow(/--confirm-host must repeat/);
  await expect(publish({ ...args, confirmHost: "ep-example.neon.tech", secondApproverId: null })).rejects.toThrow(/--second-approver is required/);
  await expect(publish({ ...args, confirmHost: "ep-example.neon.tech", api: "ftp://x" })).rejects.toThrow(/--api must be an http/);
});
