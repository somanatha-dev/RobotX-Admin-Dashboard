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

function createFakeIo() {
  const rooms = new Map();
  const io = {
    to: jest.fn((room) => ({
      emit: jest.fn((event, payload) => {
        const list = rooms.get(room) || [];
        list.push({ event, payload });
        rooms.set(room, list);
      }),
    })),
    emit: jest.fn(),
    _rooms: rooms,
  };
  return io;
}

module.exports = { createFakeSocket, createFakeIo };
