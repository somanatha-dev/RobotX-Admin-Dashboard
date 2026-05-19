const asyncHandler = require("../utils/asyncHandler");

function getSimulator(req, res) {
  const sim = req.app?.locals?.virtualSimulator;
  if (!sim) {
    res.status(503).json({ error: "Virtual robot simulator is not initialised" });
    return null;
  }
  return sim;
}

const getStatus = asyncHandler(async (req, res) => {
  const sim = req.app?.locals?.virtualSimulator;
  if (!sim) return res.status(503).json({ error: "Simulator not initialised" });
  res.json(sim.getStatus());
});

const startSimulator = asyncHandler(async (req, res) => {
  const sim = getSimulator(req, res);
  if (!sim) return;
  await sim.start();
  res.json({ ok: true, status: sim.getStatus() });
});

const stopSimulator = asyncHandler(async (req, res) => {
  const sim = getSimulator(req, res);
  if (!sim) return;
  sim.stop();
  res.json({ ok: true });
});

const resetSimulator = asyncHandler(async (req, res) => {
  const sim = getSimulator(req, res);
  if (!sim) return;
  sim.reset();
  res.json({ ok: true, status: sim.getStatus() });
});

const setConfig = asyncHandler(async (req, res) => {
  const sim = getSimulator(req, res);
  if (!sim) return;
  sim.setConfig(req.body || {});
  res.json({ ok: true });
});

module.exports = { getStatus, startSimulator, stopSimulator, resetSimulator, setConfig };
