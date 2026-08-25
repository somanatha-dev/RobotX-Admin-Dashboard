/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LABELS + CAMERA — the hierarchy holds, and the camera converges
 *
 * Two independent claims, both of which are easy to *believe* while watching a
 * map and hard to be sure of:
 *
 *   §9   a detail label must not be eligible to draw at campus-overview zoom
 *   §51  four filter changes in a second must leave ONE live camera command
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAMPUS_FEATURE_KIND,
  CAMPUS_CATEGORY,
  LABEL_PRIORITY,
  PROVENANCE,
  VERIFICATION,
  isLabelVisibleAtZoom,
  labelMinZoomFor,
} from '../campus/campusSchema.js';
import {
  CAMPUS_LAYER,
  CAMPUS_LAYER_ORDER,
  CAMPUS_SOURCE,
  campusCollections,
  campusLayerSpecs,
  labelAnchorFor,
  selectedLabelFilter,
} from '../campus/campusLayers.js';
import { buildCampusSearchIndex, searchCampusIndex, SEARCH_RESULT_TYPE } from '../campus/campusSearch.js';
import {
  CAMPUS_CAMERA_MODE,
  CAMPUS_CAMERA_PRESETS,
  campusCameraFor,
  createCameraSequencer,
} from '../camera/cameraModes.js';
import { MAX_PITCH } from '../environment/environmentConfig.js';

function feature(over = {}) {
  return {
    id: 'f1',
    name: 'Feature One',
    kind: CAMPUS_FEATURE_KIND.LANDMARK,
    category: CAMPUS_CATEGORY.OPERATIONAL,
    labelPriority: LABEL_PRIORITY.PRIMARY,
    geometry: { type: 'Point', coordinates: [77.5186, 12.9023] },
    provenance: PROVENANCE.SURVEYED,
    verification: VERIFICATION.NOT_VERIFIED,
    verifiedOn: null,
    source: 'test fixture',
    ...over,
  };
}

// ── Label hierarchy ─────────────────────────────────────────────────────────

test('label priorities become distinct, increasing zoom thresholds', () => {
  const p1 = labelMinZoomFor(LABEL_PRIORITY.PRIMARY);
  const p2 = labelMinZoomFor(LABEL_PRIORITY.SECONDARY);
  const p3 = labelMinZoomFor(LABEL_PRIORITY.DETAIL);

  assert.ok(p1 < p2 && p2 < p3, 'the bands must be ordered, or the hierarchy is not one');
  // An unknown priority must not become the most visible thing on the map.
  assert.equal(labelMinZoomFor(99), p3);
  assert.equal(labelMinZoomFor(undefined), p3);
});

test('detail labels do not appear at campus-overview zoom (§9)', () => {
  const overview = CAMPUS_CAMERA_PRESETS.OVERVIEW.zoom; // where arrival settles

  assert.equal(isLabelVisibleAtZoom(LABEL_PRIORITY.PRIMARY, overview), true);
  assert.equal(isLabelVisibleAtZoom(LABEL_PRIORITY.SECONDARY, overview), true);
  assert.equal(isLabelVisibleAtZoom(LABEL_PRIORITY.DETAIL, overview), false, 'the whole point of the hierarchy');

  // Far out, only the primary band survives.
  assert.equal(isLabelVisibleAtZoom(LABEL_PRIORITY.PRIMARY, 14), true);
  assert.equal(isLabelVisibleAtZoom(LABEL_PRIORITY.SECONDARY, 14), false);

  // Zoomed right in, everything is eligible.
  assert.equal(isLabelVisibleAtZoom(LABEL_PRIORITY.DETAIL, 18.5), true);

  // Below every band nothing draws — no label leaks to the city view.
  for (const p of [1, 2, 3]) {
    assert.equal(isLabelVisibleAtZoom(p, 11), false);
    assert.equal(isLabelVisibleAtZoom(p, undefined), false);
  }
});

test('each label layer carries the minzoom its priority declares', () => {
  // The gate is per-LAYER because the style spec does not allow a `zoom`
  // expression inside a filter. If the layers and the schema ever disagree,
  // the hierarchy silently stops working on the live map only.
  const specs = campusLayerSpecs();
  const byId = Object.fromEntries(specs.map((s) => [s.id, s]));

  const pairs = [
    [CAMPUS_LAYER.LABEL_P1, LABEL_PRIORITY.PRIMARY],
    [CAMPUS_LAYER.LABEL_P2, LABEL_PRIORITY.SECONDARY],
    [CAMPUS_LAYER.LABEL_P3, LABEL_PRIORITY.DETAIL],
  ];

  for (const [layerId, priority] of pairs) {
    const spec = byId[layerId];
    assert.ok(spec, `${layerId} must exist`);
    assert.equal(spec.minzoom, labelMinZoomFor(priority));
    assert.deepEqual(spec.filter, ['==', ['get', 'labelPriority'], priority]);
    assert.equal(spec.layout['text-allow-overlap'], false, 'labels must yield to collision detection');
    // ── Which label survives a collision (§3K) ─────────────────────────────
    // Sorting by `labelPriority` inside a layer that is already FILTERED to one
    // priority made the key a constant, so collisions were decided by source
    // order — an accident, not a hierarchy. `labelRank` is the operational
    // priority derived at import, so the gate beats the department and the
    // department beats the fountain. `labelPriority` stays as the fallback for
    // a definition built before the operational model existed.
    assert.deepEqual(spec.layout['symbol-sort-key'], [
      'coalesce',
      ['get', 'labelRank'],
      ['get', 'labelPriority'],
    ]);
  }
});

test('the selected feature gets a label that cannot be collided away (§3K)', () => {
  // "Always prioritize the selected feature" is not something a sort key can
  // deliver: a label already dropped at this zoom is not competing for space at
  // all, so raising its rank changes nothing. Only a layer that ignores
  // placement guarantees the thing an operator just clicked is readable.
  const spec = campusLayerSpecs().find((s) => s.id === CAMPUS_LAYER.LABEL_SELECTED);
  assert.ok(spec, 'the selected-label layer must exist');
  assert.equal(spec.layout['text-allow-overlap'], true);
  assert.equal(spec.layout['text-ignore-placement'], true);
  assert.equal(spec.minzoom, undefined, 'a selection made from search must be readable on arrival');

  // Safe only because it is empty until something is selected. With no
  // selection the filter must match no feature; with one, exactly that one.
  assert.deepEqual(selectedLabelFilter(null), ['==', ['get', 'id'], ' no selection ']);
  assert.deepEqual(selectedLabelFilter('osm-way-123'), ['==', ['get', 'id'], 'osm-way-123']);
  assert.deepEqual(spec.filter, selectedLabelFilter(null));
});

test('labels are anchored to the world, not to the screen (§10)', () => {
  // A label whose placement did not come from a source geometry would be an
  // HTML overlay that drifts off its building the moment the camera moves.
  for (const spec of campusLayerSpecs().filter((s) => s.type === 'symbol')) {
    assert.equal(spec.source, CAMPUS_SOURCE.LABELS);
    assert.ok(spec.layout['text-field'], 'a label layer must render a field from the data');
  }
});

test('a label anchor is derived from real geometry, never invented', () => {
  assert.deepEqual(labelAnchorFor({ type: 'Point', coordinates: [77.5, 12.9] }), [77.5, 12.9]);

  // A closed square's anchor is its centre, and the repeated closing vertex
  // must not drag it toward one corner.
  const square = {
    type: 'Polygon',
    coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
  };
  assert.deepEqual(labelAnchorFor(square), [1, 1]);

  // Nothing derivable means no label — not a label at (0, 0).
  assert.equal(labelAnchorFor(null), null);
  assert.equal(labelAnchorFor({ type: 'Polygon', coordinates: [[]] }), null);
});

test('features are routed to the source their geometry belongs in', () => {
  const definition = {
    features: [
      feature({ id: 'gate', kind: CAMPUS_FEATURE_KIND.GATE }),
      feature({
        id: 'blk',
        kind: CAMPUS_FEATURE_KIND.BUILDING,
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      }),
      feature({
        id: 'road',
        kind: CAMPUS_FEATURE_KIND.ROAD,
        roadClass: 'main',
        geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      }),
      feature({
        id: 'edge',
        kind: CAMPUS_FEATURE_KIND.BOUNDARY,
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
      }),
    ],
  };

  const c = campusCollections(definition);
  assert.deepEqual(c[CAMPUS_SOURCE.AREAS].features.map((f) => f.id), ['blk', 'edge']);
  assert.deepEqual(c[CAMPUS_SOURCE.LINES].features.map((f) => f.id), ['road']);
  assert.deepEqual(c[CAMPUS_SOURCE.POINTS].features.map((f) => f.id), ['gate']);

  // A boundary is ground, not a place — labelling one puts a name in the middle
  // of the campus that belongs to no building.
  assert.deepEqual(c[CAMPUS_SOURCE.LABELS].features.map((f) => f.properties.id), ['gate', 'blk', 'road']);
});

test('a building with no recorded height renders flat rather than guessed', () => {
  const c = campusCollections({
    features: [
      feature({
        id: 'noheight',
        kind: CAMPUS_FEATURE_KIND.BUILDING,
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      }),
    ],
  });
  assert.equal('height' in c[CAMPUS_SOURCE.AREAS].features[0].properties, false);
});

test('an empty campus produces empty sources, not absent ones', () => {
  const c = campusCollections({ features: [] });
  for (const sourceId of Object.values(CAMPUS_SOURCE)) {
    assert.deepEqual(c[sourceId], { type: 'FeatureCollection', features: [] });
  }
});

test('every declared layer has a spec, in draw order', () => {
  const specIds = campusLayerSpecs().map((s) => s.id);
  assert.deepEqual([...specIds].sort(), [...CAMPUS_LAYER_ORDER].sort());
});

// ── Search ──────────────────────────────────────────────────────────────────

test('search finds only what exists, and never offers a place it cannot locate', () => {
  const definition = { features: [feature({ id: 'gate-1', name: 'Main Gate', kind: CAMPUS_FEATURE_KIND.GATE })] };
  const robots = [{ robotId: 'RX-0042', lat: 12.9, lon: 77.5, status: 'ACTIVE' }];
  const index = buildCampusSearchIndex({ definition, robots });

  assert.equal(index.length, 2);

  const gate = searchCampusIndex(index, 'main')[0];
  assert.equal(gate.name, 'Main Gate');
  assert.equal(gate.type, SEARCH_RESULT_TYPE.CAMPUS_FEATURE);
  assert.deepEqual([gate.lon, gate.lat], [77.5186, 12.9023]);

  const robot = searchCampusIndex(index, 'RX-00')[0];
  assert.equal(robot.type, SEARCH_RESULT_TYPE.ROBOT);
  assert.equal(robot.robotId, 'RX-0042');

  // The thing this index must NOT do: return a plausible campus place that is
  // not in the dataset.
  assert.deepEqual(searchCampusIndex(index, 'Central Library'), []);
  assert.deepEqual(searchCampusIndex(index, ''), []);
});

test('a robot with no position is not searchable — there is nowhere to fly', () => {
  const index = buildCampusSearchIndex({ robots: [{ robotId: 'RX-1' }, { robotId: 'RX-2', lat: 1, lon: 2 }] });
  assert.deepEqual(index.map((e) => e.robotId), ['RX-2']);
});

// ── Camera ──────────────────────────────────────────────────────────────────

test('campus camera modes are distinct, tilted, and within the map’s pitch limit', () => {
  const modes = Object.values(CAMPUS_CAMERA_MODE);
  const zooms = modes.map((m) => campusCameraFor(m).zoom);
  assert.equal(new Set(zooms).size, modes.length, 'modes that frame identically are not modes');

  for (const mode of modes) {
    const preset = campusCameraFor(mode);
    assert.ok(preset.pitch > 0, `${mode} must be tilted — the depth is the point at campus zoom`);
    assert.ok(preset.pitch <= MAX_PITCH, `${mode} pitch would be silently clamped by Mapbox`);
    // §27: north-up, so an operator can match the map to the physical site.
    assert.equal(preset.bearing, 0, `${mode} must land north-up`);
  }

  assert.ok(CAMPUS_CAMERA_PRESETS.OPERATIONS.zoom > CAMPUS_CAMERA_PRESETS.OVERVIEW.zoom);
  assert.equal(campusCameraFor('NOT_A_MODE').zoom, CAMPUS_CAMERA_PRESETS.OVERVIEW.zoom);
});

test('rapid filter changes converge on the latest target (§51)', () => {
  const seq = createCameraSequencer();

  // India → Karnataka → Bengaluru → RNSIT, faster than any flight completes.
  const india = seq.begin();
  const karnataka = seq.begin();
  const bengaluru = seq.begin();
  const rnsit = seq.begin();

  // Every abandoned flight's deferred stage (the tilt, the campus reveal) is
  // refused. Exactly one command may still touch the camera.
  assert.equal(seq.isCurrent(india), false);
  assert.equal(seq.isCurrent(karnataka), false);
  assert.equal(seq.isCurrent(bengaluru), false);
  assert.equal(seq.isCurrent(rnsit), true);

  // A camera mode change afterwards supersedes the arrival in turn.
  const modeChange = seq.begin();
  assert.equal(seq.isCurrent(rnsit), false);
  assert.equal(seq.isCurrent(modeChange), true);
});

test('cancelling supersedes everything without handing out a usable token', () => {
  const seq = createCameraSequencer();
  const flight = seq.begin();
  seq.cancel();

  assert.equal(seq.isCurrent(flight), false, 'the in-flight command must be stopped');
  assert.equal(seq.isCurrent(seq.current), false, 'cancel must not leave a live token behind');
});

test('a token from a fresh sequencer is never spuriously current', () => {
  const seq = createCameraSequencer();
  assert.equal(seq.isCurrent(0), false);
  assert.equal(seq.isCurrent(undefined), false);
});
