"use strict";

/**
 * A **null** routing adapter for the B1 benchmark's own tests. It is not a candidate engine
 * and it must never be used as one.
 *
 * It answers from arithmetic, instantly, with no network and no map. Its only purpose is to
 * let `tools/routing/b1Benchmark.js`'s CLI path run end to end so that the exit-code
 * behaviour can be asserted — specifically, that a zero-latency adapter is no longer failed
 * on a row that is a property of the harness rather than of the engine.
 *
 * Any figure produced with this adapter behind the harness is a property of the harness and
 * the two shipped caches. **It is not B1 evidence and it is not §20.1 gate evidence.** B1 is
 * closed by measuring deployed engines with per-profile contraction hierarchies built over a
 * real region extract, on representative hardware — never by this file.
 */

module.exports = {
  id: "null-adapter",
  description: "test fixture; routes nothing; not a candidate engine and not B1 evidence",
  profile: { energyWhPerMetre: 0.05, speedMetresPerSecond: 5 },

  async matrix({ destCellIds }) {
    return (destCellIds || []).map((destCellId, index) => ({
      destCellId,
      distanceM: 100 + index,
      travelSeconds: 20 + index,
      travelSdSeconds: 1,
    }));
  },

  async nearestChargers({ k }) {
    return Array.from({ length: k || 1 }, (unused, index) => ({
      chargerId: `C${index}`,
      distanceM: 500 + index * 10,
      travelSeconds: 100 + index,
    }));
  },
};
