// Polls `predicate` until it returns truthy, or throws after `timeout` ms.
// Used to observe the result of code that runs on a `setImmediate()`
// background phase (e.g. task.service.js's assignTask) without coupling the
// test to Node's exact macrotask/microtask interleaving.
async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitFor: condition not met within ${timeout}ms`);
}

module.exports = { waitFor };
