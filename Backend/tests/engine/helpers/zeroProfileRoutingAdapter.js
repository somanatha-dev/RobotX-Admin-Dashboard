"use strict";

/**
 * A routing adapter whose declared profile is **zero**, for the B1 benchmark's own tests.
 *
 * The companion to `profilelessRoutingAdapter.js`, and the harder half: a missing profile is
 * visibly missing, while a zero one satisfies "the field is present". It is not a speed.
 * `chargerReachabilityCache.buildEntry` computes `travelSeconds + intraCellOffsetM /
 * speedMetresPerSecond`, so a zero yields `Infinity`, the entry is refused per-row, and the
 * symptom is an empty cache rather than a configuration error anybody would look at.
 *
 * Not a candidate engine and not B1 evidence.
 */

module.exports = {
  id: "zero-profile-adapter",
  description: "test fixture; declares a zero profile, which is not a profile",
  profile: { energyWhPerMetre: 0, speedMetresPerSecond: 0 },

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
