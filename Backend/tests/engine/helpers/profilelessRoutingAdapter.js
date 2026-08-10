"use strict";

/**
 * A routing adapter that **declares no mobility profile**, for the B1 benchmark's own tests.
 *
 * It is `nullRoutingAdapter.js` with one field removed, and that field is the whole point.
 * Until PHASE 15 the benchmark filled it in — `energyWhPerMetre: 0.05`, `speedMetresPerSecond:
 * 5` — so an adapter in exactly this shape was measured against a **fleet speed the harness
 * chose for it**. Speed as a function of the fleet's real locomotion is decision **D3**
 * (Product + Fleet Engineering) and is open.
 *
 * This fixture exists so the refusal has a test. It is not a candidate engine, it is not B1
 * evidence, and it must never be used as either.
 */

module.exports = {
  id: "profileless-adapter",
  description: "test fixture; declares no profile, so it must not be measured",

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
