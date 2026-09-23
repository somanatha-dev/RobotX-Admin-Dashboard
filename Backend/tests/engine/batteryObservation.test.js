"use strict";

/**
 * The reported state of charge reaches the column the energy decision reads — and only as
 * an update of an existing row, never a creation (a created `BatteryState` carries
 * `kappa`'s default of 1, an uncalibrated agent presented as a calibrated one).
 */

const batteryObservation = require("../../src/services/batteryObservation.service");

function prismaWith({ agent = { id: "agent-row-1" }, count = 1 } = {}) {
  return {
    agent: { findUnique: jest.fn(async () => agent) },
    batteryState: {
      updateMany: jest.fn(async () => ({ count })),
      upsert: jest.fn(),
      create: jest.fn(),
    },
  };
}

describe("recordReportedSoc", () => {
  test("writes the reported percentage as a fraction, at the agent's own timestamp", async () => {
    const prisma = prismaWith();
    const out = await batteryObservation.recordReportedSoc(prisma, { robotId: "SIM-1", batteryPct: 42.5, agentTimestampMs: 1_700_000_000_000 });
    expect(out).toEqual({ written: true, reason: null });
    const call = prisma.batteryState.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ lastObservedSoc: 0.425, lastObservedAt: new Date(1_700_000_000_000) });
    expect(call.where.agentId).toBe("agent-row-1");
  });

  test("never creates a row — only updateMany is ever called", async () => {
    const prisma = prismaWith({ count: 0 });
    const out = await batteryObservation.recordReportedSoc(prisma, { robotId: "PHYS-1", batteryPct: 80, agentTimestampMs: 1_700_000_000_000 });
    expect(out.written).toBe(false);
    expect(prisma.batteryState.upsert).not.toHaveBeenCalled();
    expect(prisma.batteryState.create).not.toHaveBeenCalled();
  });

  test("never moves backwards: the write is conditioned on an older stored observation", async () => {
    const prisma = prismaWith();
    await batteryObservation.recordReportedSoc(prisma, { robotId: "SIM-1", batteryPct: 50, agentTimestampMs: 1_700_000_000_000 });
    const { where } = prisma.batteryState.updateMany.mock.calls[0][0];
    expect(where.OR).toEqual([{ lastObservedAt: null }, { lastObservedAt: { lt: new Date(1_700_000_000_000) } }]);
  });

  test.each([
    ["no reported battery", { batteryPct: null }, "NO_REPORTED_SOC"],
    ["a battery outside 0–100 %", { batteryPct: 140 }, "NO_REPORTED_SOC"],
    ["a 0–1 fraction is still read as percent, so 0.9 is 0.9 %, not refused", { batteryPct: 0.9 }, null],
    ["no agent timestamp", { agentTimestampMs: undefined }, "NO_AGENT_TIMESTAMP"],
  ])("%s", async (_name, override, reason) => {
    const prisma = prismaWith();
    const out = await batteryObservation.recordReportedSoc(prisma, { robotId: "SIM-1", batteryPct: 60, agentTimestampMs: 1_700_000_000_000, ...override });
    expect(out.reason).toBe(reason);
    if (reason) expect(prisma.batteryState.updateMany).not.toHaveBeenCalled();
  });

  test("an unknown robot writes nothing", async () => {
    const prisma = prismaWith({ agent: null });
    const out = await batteryObservation.recordReportedSoc(prisma, { robotId: "NOBODY", batteryPct: 60, agentTimestampMs: 1 });
    expect(out).toEqual({ written: false, reason: "NO_AGENT" });
    expect(prisma.batteryState.updateMany).not.toHaveBeenCalled();
  });
});
