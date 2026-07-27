const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const silentLogger = require("../../mocks/silentLogger");

// The operator command endpoint persists a Command row and dispatches
// "COMMAND" with that row's id; the robot must act on it AND acknowledge it
// with COMMAND_ACK so command.handler can move the row from SENT to ACK.
//
// VirtualRobot previously listened only for the bare "STOP" and
// "RETURN_TO_BASE" events, so every operator command against a virtual robot
// was ignored, never acknowledged, and marked FAILED by the reliability
// scheduler ~15s later. RETURN_TO_BASE in particular was emitted by nothing
// at all — dead on both ends.

function makeRobot() {
  const vr = new VirtualRobot({ robotId: "R1", lat: 12.9, lon: 77.5, logger: silentLogger, kv: null });
  const sent = [];
  vr.socket = {
    connected: true,
    emit: (event, payload) => sent.push({ event, payload }),
    on: () => {},
  };
  vr.connected = true;
  return { vr, sent };
}

/** Put the robot into the middle of a task, as if TASK_ASSIGN had arrived. */
function withActiveTask(vr) {
  vr.task = { taskId: "TSK-1", pathToPickup: [{ lat: 12.9, lon: 77.5 }], pathToDrop: [] };
  vr.phase = "TO_PICKUP";
  vr.activePath = vr.task.pathToPickup;
  vr.status = "ACTIVE";
  vr.speed = 5.5;
}

describe("VirtualRobot — operator COMMAND handling", () => {
  test("STOP halts the robot and acknowledges the command id", () => {
    const { vr, sent } = makeRobot();
    withActiveTask(vr);

    vr._onCommand({ commandId: "cmd-1", type: "STOP" });

    expect(vr.status).toBe("PAUSED");
    expect(vr.speed).toBe(0);
    expect(sent).toEqual([
      { event: "COMMAND_ACK", payload: expect.objectContaining({ commandId: "cmd-1", robotId: "R1" }) },
    ]);
  });

  test("PAUSE behaves as STOP and retains the task so RESUME can pick it back up", () => {
    const { vr } = makeRobot();
    withActiveTask(vr);

    vr._onCommand({ commandId: "cmd-2", type: "PAUSE" });

    expect(vr.status).toBe("PAUSED");
    expect(vr.task).not.toBeNull();
    expect(vr.phase).toBe("TO_PICKUP");
  });

  test("RESUME returns a paused robot with a task to ACTIVE", () => {
    const { vr, sent } = makeRobot();
    withActiveTask(vr);
    vr._onCommand({ commandId: "cmd-3", type: "PAUSE" });

    vr._onCommand({ commandId: "cmd-4", type: "RESUME" });

    expect(vr.status).toBe("ACTIVE");
    expect(sent.map((s) => s.payload.commandId)).toEqual(["cmd-3", "cmd-4"]);
  });

  test("RESUME on a robot with no task just returns it to IDLE", () => {
    const { vr } = makeRobot();
    vr.status = "PAUSED";

    vr._onCommand({ commandId: "cmd-5", type: "RESUME" });

    expect(vr.status).toBe("IDLE");
  });

  test("RESUME is refused while charging rather than half-applied", () => {
    const { vr } = makeRobot();
    vr.status = "CHARGING";

    vr._onCommand({ commandId: "cmd-6", type: "RESUME" });

    expect(vr.status).toBe("CHARGING");
  });

  test("RETURN abandons the task entirely and goes idle", () => {
    const { vr, sent } = makeRobot();
    withActiveTask(vr);

    vr._onCommand({ commandId: "cmd-7", type: "RETURN" });

    expect(vr.status).toBe("IDLE");
    expect(vr.task).toBeNull();
    expect(vr.phase).toBeNull();
    expect(vr.speed).toBe(0);
    expect(sent[0].payload.commandId).toBe("cmd-7");
  });

  test("an unknown command type is ignored and deliberately NOT acknowledged", () => {
    const { vr, sent } = makeRobot();
    withActiveTask(vr);

    vr._onCommand({ commandId: "cmd-8", type: "SELF_DESTRUCT" });

    expect(vr.status).toBe("ACTIVE"); // untouched
    expect(sent).toHaveLength(0);     // no ACK -> the row correctly ends up FAILED
  });

  test("command types are matched case-insensitively", () => {
    const { vr, sent } = makeRobot();
    withActiveTask(vr);

    vr._onCommand({ commandId: "cmd-9", type: "stop" });

    expect(vr.status).toBe("PAUSED");
    expect(sent).toHaveLength(1);
  });

  test("STOP is still honoured as a bare event (task cancellation path)", () => {
    const { vr, sent } = makeRobot();
    withActiveTask(vr);

    vr._applyStop("STOP");

    expect(vr.status).toBe("PAUSED");
    expect(sent).toHaveLength(0); // cancellation STOP expects no ACK
  });

  test("a charging robot is not knocked out of CHARGING by STOP", () => {
    const { vr } = makeRobot();
    vr.status = "CHARGING";

    vr._onCommand({ commandId: "cmd-10", type: "STOP" });

    expect(vr.status).toBe("CHARGING");
  });
});
