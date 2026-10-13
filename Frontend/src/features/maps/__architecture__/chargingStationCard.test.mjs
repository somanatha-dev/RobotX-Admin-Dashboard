/**
 * The charging-station details card, rendered.
 *
 * The card is a NON-MODAL information panel beside the map: the map stays interactive and focus
 * is not moved into it. So it is a labelled region, not a `dialog` — which would promise focus
 * management (focus moved in, contained, returned) that the panel does not have.
 *
 * `node --test` cannot import `.jsx`, so the real component file is compiled here with Vite's
 * own transform (`transformWithOxc`, already a dependency) and rendered with `react-dom/server`.
 * Nothing about the component is re-implemented for the test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

import { stationSummaries } from '../charging/stationModel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARD = path.resolve(HERE, '../mapControl/ui/ChargingStationCard.jsx');

/** Compile the real `.jsx`, point its imports at absolute URLs, and import it from memory. */
async function loadCard() {
  const source = fs.readFileSync(CARD, 'utf8');
  const { code } = await transformWithOxc(source, CARD, { lang: 'jsx', jsx: { runtime: 'automatic' } });
  const absolute = code.replace(/(from\s+)(["'])([^"']+)\2/g, (_m, from, quote, spec) => {
    const target = spec.startsWith('.') ? pathToFileURL(path.resolve(path.dirname(CARD), spec)).href : import.meta.resolve(spec);
    return `${from}${quote}${target}${quote}`;
  });
  return import(`data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`);
}

// The backend's report shape (`GET /api/simulator/status` → `charging.stations`): the depot,
// PU College (approved, usable), Canara Bank (declared, not approved).
const REPORT = {
  robots: [],
  charging: {
    provenance: 'DEVELOPMENT_SIMULATION',
    stations: [
      { chargerId: 'V1DEMO-DEPOT-01', name: 'Depot', isDepot: true, approved: true, usable: true, lat: 12.900729, lon: 77.517603, problems: [], inEstate: true, plugCount: 3, active: 1, queued: 0 },
      { chargerId: 'RNSIT-CHG-PU-COLLEGE', name: 'Near RNSIT PU College building', isDepot: false, approved: true, usable: true, lat: 12.900742024769887, lon: 77.51884060360668, declaredLat: 12.900742024769887, declaredLon: 77.51884060360668, problems: [], inEstate: true, plugCount: 1, active: 0, queued: 0 },
      { chargerId: 'RNSIT-CHG-CANARA-BANK', name: 'Near RNSIT Canara Bank', isDepot: false, approved: false, usable: false, lat: null, lon: null, declaredLat: 12.902396962367357, declaredLon: 77.51862316497345, problems: [{ code: 'NOT_APPROVED' }], inEstate: false, plugCount: null, active: 0, queued: 0 },
    ],
  },
};
const summary = (chargerId) => stationSummaries(REPORT).find((s) => s.chargerId === chargerId);

test('the card is a labelled, non-modal region — never a dialog', async () => {
  const { ChargingStationCard } = await loadCard();
  const html = renderToStaticMarkup(React.createElement(ChargingStationCard, { station: summary('RNSIT-CHG-PU-COLLEGE'), onClose() {}, onFocus() {} }));
  assert.match(html, /^<div class="map-feature-card map-station-card" role="region" aria-label="Charging station Near RNSIT PU College building">/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /aria-modal/);
  // Its controls keep their own accessible names.
  assert.match(html, /<button type="button" class="map-feature-card__close" aria-label="Close station details">/);
  assert.match(html, />Focus on station</);
});

test('an approved, usable station shows its plugs and operational coordinate', async () => {
  const { ChargingStationCard } = await loadCard();
  const html = renderToStaticMarkup(React.createElement(ChargingStationCard, { station: summary('RNSIT-CHG-PU-COLLEGE') }));
  assert.match(html, /<dt>State<\/dt><dd>Available<\/dd>/);
  assert.match(html, /<dt>Plugs<\/dt><dd>0 of 1 in use<\/dd>/);
  assert.match(html, /<dt>Coordinates<\/dt><dd>12\.900742, 77\.518841<\/dd>/);
  assert.match(html, /<dt>Owner approval<\/dt><dd>Approved<\/dd>/);
});

test('an unapproved station is labelled inactive at its DECLARED coordinate, with no plug figures', async () => {
  const { ChargingStationCard } = await loadCard();
  const html = renderToStaticMarkup(React.createElement(ChargingStationCard, { station: summary('RNSIT-CHG-CANARA-BANK') }));
  assert.match(html, /role="region" aria-label="Charging station Near RNSIT Canara Bank"/);
  assert.match(html, /<dt>State<\/dt><dd>Inactive — not approved<\/dd>/);
  assert.match(html, /<dt>Declared coordinates<\/dt><dd>12\.902397, 77\.518623<\/dd>/);
  assert.match(html, /<dt>Owner approval<\/dt><dd>Not approved<\/dd>/);
  assert.doesNotMatch(html, /<dt>Plugs<\/dt>/);
  assert.match(html, /the owner has not approved it, so no robot is sent here/);
});

test('no station renders nothing', async () => {
  const { ChargingStationCard } = await loadCard();
  assert.equal(renderToStaticMarkup(React.createElement(ChargingStationCard, { station: null })), '');
});
