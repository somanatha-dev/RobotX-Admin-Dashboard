// Shared in-memory registry of active robot sockets.
// Kept in a separate module so both Socket.io handlers and HTTP controllers can use it.

/** @type {Map<string, import('socket.io').Socket>} */
const robotSockets = new Map();

function getRobotSocket(robotId) {
  if (!robotId) return null;
  return robotSockets.get(String(robotId)) || null;
}

function setRobotSocket(robotId, socket) {
  if (!robotId || !socket) return;
  robotSockets.set(String(robotId), socket);
}

function deleteRobotSocket(robotId, socket) {
  const key = String(robotId);
  const current = robotSockets.get(key);
  if (current && socket && current.id !== socket.id) return;
  robotSockets.delete(key);
}

function disconnectSocket(socket) {
  if (!socket) return;
  try {
    socket.disconnect(true);
  } catch {
    // ignore
  }
}

module.exports = {
  getRobotSocket,
  setRobotSocket,
  deleteRobotSocket,
  disconnectSocket,
};
