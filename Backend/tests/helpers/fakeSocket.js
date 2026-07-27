const { EventEmitter } = require("events");

// A fake Socket.IO socket good enough to drive handler modules that call
// `socket.on(event, handler)` then later `socket.emit(...)`/`.join(...)`.
// Real socket.io sockets are themselves EventEmitter-like on the outbound
// side; we use a plain EventEmitter so `socket.on("EVENT", cb)` registers a
// real listener tests can trigger with `socket.emit("EVENT", payload)` the
// same way socket.io itself would dispatch an inbound client event.
let counter = 0;

function createFakeSocket({ id, data } = {}) {
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    id: id || `fake-socket-${++counter}`,
    data: data || {},
    handshake: { headers: {}, auth: {} },
    conn: { transport: { ws: { bufferedAmount: 0 } } },
    join: jest.fn(),
    leave: jest.fn(),
    disconnect: jest.fn(),
    // Track outbound emits separately from the EventEmitter's own `emit`
    // (which we repurpose to simulate inbound client events in tests).
    sent: [],
  });

  const originalEmit = emitter.emit.bind(emitter);
  socket.emitToClient = jest.fn((event, payload) => {
    socket.sent.push({ event, payload });
  });

  // Socket.IO's real `.emit` sends to the client; our fake distinguishes
  // "trigger a handler" (inbound, via EventEmitter) from "send to client"
  // by exposing both. Handler modules under test only ever call
  // `socket.emit(...)` to talk to the client, so we override `emit` to do
  // that, and expose `trigger` for tests to invoke a registered listener.
  socket.emit = (event, payload) => {
    socket.emitToClient(event, payload);
    return true;
  };
  socket.trigger = (event, payload) => originalEmit(event, payload);

  return socket;
}

// Production code emits to rooms (io.to("dashboard").emit(...)), never
// globally — a bare io.emit would fan out to every connected socket including
// every other robot. `roomEmits`/`emittedTo` are the assertion surface for
// that: reach for them rather than io.emit.mock.calls, which stays here only
// to prove a global emit did NOT happen.
function createFakeIo() {
  const rooms = new Map();   // room -> [{ event, payload }] emitted to it
  const members = new Map(); // room -> [socket-like] present in it

  const target = (room) => ({
    emit: jest.fn((event, payload) => {
      const list = rooms.get(room) || [];
      list.push({ event, payload });
      rooms.set(room, list);
    }),
    // commandDispatcher checks presence with io.in(room).fetchSockets() before
    // emitting, so a room with no members must genuinely refuse delivery here —
    // otherwise the tests would not be able to tell "dispatched" from "dropped".
    fetchSockets: async () => members.get(room) || [],
  });

  const io = {
    to: jest.fn(target),
    in: jest.fn(target),
    emit: jest.fn(),
    _rooms: rooms,

    /** Put a socket-like object in a room so fetchSockets() finds it. */
    joinRoom(room, socket) {
      const list = members.get(room) || [];
      list.push(socket || { id: `fake-${room}` });
      members.set(room, list);
      return io;
    },
    /** Every {event, payload} emitted to `room`, in order. */
    roomEmits(room) {
      return rooms.get(room) || [];
    },
    /** Every payload emitted to `room` under `event`, in order. */
    emittedTo(room, event) {
      return (rooms.get(room) || []).filter((m) => m.event === event).map((m) => m.payload);
    },
  };
  return io;
}

module.exports = { createFakeSocket, createFakeIo };
