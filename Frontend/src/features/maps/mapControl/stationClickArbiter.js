/**
 * One map click, two listeners: the charging layer answers "which station, if any" and the
 * campus layer answers "which building (or basemap feature), if any". Mapbox runs both for the
 * same click, in registration order — which neither layer controls — so a click on a station
 * standing on a building used to be able to select the building too.
 *
 * The rule: a click that hits a station selects the station and nothing underneath it, in either
 * listener order. The station listener CLAIMS the click (clearing any building the campus
 * listener may already have selected for it); a campus answer arriving while the claim stands is
 * ignored. The claim lasts until the current task ends — both listeners run synchronously in the
 * same dispatch — and is released in a microtask, so the next click is judged afresh.
 *
 * A click that hits no station clears the station selection and leaves the campus answer alone.
 * Moved out of `MapControl.jsx` unchanged, so the tests drive the same object the page uses.
 *
 * @param {object} options
 * @param {(chargerId: string|null) => void} options.selectStation
 * @param {(feature: object|null) => void} options.selectFeature
 * @param {(fn: () => void) => void} [options.schedule] when the claim is released (a microtask)
 */
export function createStationClickArbiter({ selectStation, selectFeature, schedule = (fn) => queueMicrotask(fn) }) {
  let claimed = false;
  return {
    /** The charging layer's answer for this click: a station id, or null for none. */
    station(chargerId) {
      if (chargerId) {
        claimed = true;
        schedule(() => {
          claimed = false;
        });
        selectFeature(null);
      }
      selectStation(chargerId || null);
    },
    /** The campus layer's answer for this click: a feature, or null for none. */
    feature(feature) {
      if (claimed) return;
      selectFeature(feature);
    },
  };
}
