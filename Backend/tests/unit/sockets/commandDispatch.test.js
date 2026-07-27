const { createFakeIo } = require("../../helpers/fakeSocket");

// Every server-to-robot message is addressed through the robot's Socket.IO
// room rather than a process-local socket map, so it still lands when another
// worker owns that robot's connection. These tests pin the three properties
// that make that true — and the guard that turns the old two-argument
// misuse into a loud failure instead of a silent no-op.

describe("commandDispatcher — room-based, worker-safe robot addressing", () => {
  let dispatch;
  let dispatchTaskAssign;
  let dispatchRerouteAlert;
  let dispatchCommand;
  let dispatchStop;
  let io;

  beforeEach(() => {
    jest.resetModules();
    ({ dispatch, dispatchTaskAssign, dispatchRerouteAlert, dispatchCommand, dispatchStop } =
      require("../../../src/services/commandDispatcher.service"));
    io = createFakeIo();
  });

  describe("addressing", () => {
    test("emits into the robot's own room, never globally", async () => {
      io.joinRoom("robot:R1", { id: "sock-1" });

      const result = await dispatchCommand(io, "R1", { commandId: "cmd-1", type: "STOP" });

      expect(result.dispatched).toBe(true);
      expect(io.emittedTo("robot:R1", "COMMAND")).toHaveLength(1);
      expect(io.emittedTo("robot:R1", "COMMAND")[0]).toMatchObject({ commandId: "cmd-1", type: "STOP" });
      expect(io.emit).not.toHaveBeenCalled();
    });

    test("presence is checked via the adapter-aware room, so an empty room is not delivered to", async () => {
      const result = await dispatchCommand(io, "R-absent", { commandId: "cmd-2", type: "PAUSE" });

      expect(result.dispatched).toBe(false);
      expect(io.emittedTo("robot:R-absent", "COMMAND")).toHaveLength(0);
    });

    test("dispatchStop targets the robot room with the task-cancellation payload", async () => {
      io.joinRoom("robot:R1", { id: "sock-1" });

      await dispatchStop(io, "R1", { taskId: "TSK-1", reason: "TASK_CANCELLED" });

      const [stop] = io.emittedTo("robot:R1", "STOP");
      expect(stop).toMatchObject({ taskId: "TSK-1", reason: "TASK_CANCELLED" });
      expect(stop.timestamp).toEqual(expect.any(Number));
    });

    test("dispatchTaskAssign carries the task payload plus a timestamp", async () => {
      io.joinRoom("robot:R7", { id: "sock-7" });

      const result = await dispatchTaskAssign(io, "R7", { taskId: "TSK-9", pathToPickup: [], pathToDrop: [] });

      expect(result.dispatched).toBe(true);
      expect(io.emittedTo("robot:R7", "TASK_ASSIGN")[0]).toMatchObject({ taskId: "TSK-9" });
    });
  });

  describe("misuse guard (regression: the two-argument call shipped in server.js)", () => {
    // Calling dispatchTaskAssign(robotId, payload) bound the robotId string to
    // `io`. The presence check then threw, was swallowed as "no socket
    // connected", and the caller logged a cheerful `dispatched: false` — a
    // silent no-op that looked like an offline robot. It must be loud.
    test("a missing io server is reported as NO_IO_SERVER, not as an absent robot", async () => {
      const result = await dispatchTaskAssign("R1", { taskId: "TSK-1" });

      expect(result).toMatchObject({ dispatched: false, error: "NO_IO_SERVER" });
      expect(result.attempts).toBe(0); // never even tried a room
    });

    test("the guard covers every typed helper", async () => {
      await expect(dispatchCommand(undefined, "R1", { commandId: "c", type: "STOP" }))
        .resolves.toMatchObject({ error: "NO_IO_SERVER" });
      await expect(dispatchStop(null, "R1", {}))
        .resolves.toMatchObject({ error: "NO_IO_SERVER" });
      await expect(dispatchRerouteAlert({}, "R1", {}))
        .resolves.toMatchObject({ error: "NO_IO_SERVER" });
      await expect(dispatch("not-an-io", "R1", "X", {}))
        .resolves.toMatchObject({ error: "NO_IO_SERVER" });
    });
  });

  describe("retry policy", () => {
    test("operator-initiated dispatches do not retry (they run inside a waiting HTTP request)", async () => {
      const started = Date.now();
      const result = await dispatchCommand(io, "R-absent", { commandId: "c", type: "STOP" });

      expect(result.attempts).toBe(1);
      // A retrying dispatch would have burned 1s + 2s of back-off here.
      expect(Date.now() - started).toBeLessThan(500);
    });
  });
});
