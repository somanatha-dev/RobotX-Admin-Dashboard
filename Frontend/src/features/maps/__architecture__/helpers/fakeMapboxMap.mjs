/**
 * A fake Mapbox GL map with the behaviours the map overlays depend on, modelled on
 * mapbox-gl 3.20 (`Style._checkLoaded`, `Style.addLayer`, `Map.setStyle`):
 *
 *   · before the style has loaded, addSource / addLayer / setPaintProperty / setFeatureState
 *     THROW "Style is not done loading" — the state a map built on navigating back to the
 *     page is in when cached routes first replay;
 *   · adding a layer whose id exists, or before a layer that does not, fires an `error`
 *     event and adds nothing (Mapbox does not throw for these);
 *   · `setStyle` discards every source, layer and image, then `finishStyleLoad()` fires
 *     `style.load`;
 *   · layer ORDER is kept, so stacking rules are assertable.
 */
export function createFakeMapboxMap({ loaded = false } = {}) {
  let styleLoaded = loaded;
  let layers = []; // [{ id, spec }] bottom → top
  let sources = new Map();
  let images = new Map();
  const listeners = new Map(); // type → Set(fn)
  const errors = [];
  const paintWrites = [];
  const featureState = new Map();

  const check = () => {
    if (!styleLoaded) throw new Error('Style is not done loading');
  };
  const fire = (type, event = {}) => {
    for (const fn of [...(listeners.get(type) || [])]) fn({ type, ...event });
  };

  const map = {
    // ── events
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return map;
    },
    off(type, fn) {
      listeners.get(type)?.delete(fn);
      return map;
    },
    once(type, fn) {
      const wrap = (e) => {
        map.off(type, wrap);
        fn(e);
      };
      return map.on(type, wrap);
    },
    fire,
    listenerCount: (type) => listeners.get(type)?.size || 0,

    // ── style lifecycle
    isStyleLoaded: () => styleLoaded,
    loaded: () => styleLoaded,
    finishStyleLoad() {
      styleLoaded = true;
      fire('style.load');
    },
    setStyle() {
      styleLoaded = false;
      layers = [];
      sources = new Map();
      images = new Map();
    },
    getStyle: () => ({ layers: layers.map((l) => ({ id: l.id, type: l.spec.type, ...(l.spec.layout ? { layout: l.spec.layout } : {}) })) }),

    // ── sources
    getSource: (id) => sources.get(id),
    addSource(id, spec) {
      check();
      if (sources.has(id)) {
        errors.push(`source ${id} exists`);
        return map;
      }
      const source = {
        spec,
        data: spec.data,
        setDataCalls: 0,
        setData(data) {
          source.data = data;
          source.setDataCalls += 1;
        },
      };
      sources.set(id, source);
      return map;
    },
    removeSource(id) {
      if (layers.some((l) => l.spec.source === id)) throw new Error(`Source "${id}" cannot be removed while layer is using it.`);
      sources.delete(id);
      return map;
    },

    // ── layers
    getLayer: (id) => layers.find((l) => l.id === id)?.spec,
    addLayer(spec, beforeId) {
      check();
      if (layers.some((l) => l.id === spec.id)) {
        errors.push(`layer ${spec.id} exists`);
        return map;
      }
      if (spec.source && typeof spec.source === 'string' && !sources.has(spec.source)) {
        errors.push(`layer ${spec.id}: source ${spec.source} missing`);
        return map;
      }
      if (beforeId !== undefined) {
        const at = layers.findIndex((l) => l.id === beforeId);
        if (at < 0) {
          errors.push(`layer ${spec.id}: before ${beforeId} missing`);
          return map;
        }
        layers.splice(at, 0, { id: spec.id, spec });
      } else {
        layers.push({ id: spec.id, spec });
      }
      return map;
    },
    removeLayer(id) {
      layers = layers.filter((l) => l.id !== id);
      return map;
    },
    setPaintProperty(id, prop, value) {
      check();
      const layer = layers.find((l) => l.id === id);
      if (!layer) throw new Error(`layer ${id} missing`);
      layer.spec.paint = { ...(layer.spec.paint || {}), [prop]: value };
      paintWrites.push([id, prop]);
    },
    setFilter(id, filter) {
      const layer = layers.find((l) => l.id === id);
      if (layer) layer.spec.filter = filter;
    },
    setFeatureState({ source, id }, state) {
      check();
      if (!sources.has(source)) throw new Error(`source ${source} missing`);
      const key = `${source}:${id}`;
      featureState.set(key, { ...(featureState.get(key) || {}), ...state });
    },
    getFeatureState: ({ source, id }) => featureState.get(`${source}:${id}`) || {},

    // ── images
    hasImage: (id) => images.has(id),
    addImage(id, image) {
      if (images.has(id)) throw new Error(`An image named "${id}" already exists.`);
      images.set(id, image);
    },

    // ── camera / misc (enough for the overlays)
    getZoom: () => 18,
    getPitch: () => 0,
    getBearing: () => 0,
    getCanvas: () => ({ style: {} }),
    queryRenderedFeatures: () => [],

    // ── test introspection
    layerIds: () => layers.map((l) => l.id),
    sourceIds: () => [...sources.keys()],
    imageIds: () => [...images.keys()],
    errors,
    paintWrites,
  };
  return map;
}
