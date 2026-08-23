import React from 'react';

import { PROVENANCE, VERIFICATION } from '../../campus/campusSchema.js';

const PROVENANCE_LABEL = Object.freeze({
  SURVEYED: 'Surveyed',
  SEED_RECORD: 'Database record',
  OPERATIONAL_RECORD: 'Operational record',
  VENDOR_BASEMAP: 'Basemap (OpenStreetMap via Mapbox)',
  OPEN_DATA_IMPORT: 'OpenStreetMap (imported open data)',
  USER_SUPPLIED: 'User-supplied location',
});

const CATEGORY_LABEL = Object.freeze({
  ACADEMIC: 'Academic',
  ADMINISTRATIVE: 'Administrative',
  RESIDENTIAL: 'Residential',
  SPORTS: 'Sports',
  UTILITY: 'Utility',
  COMMERCIAL: 'Commercial',
  RELIGIOUS: 'Religious',
  CIRCULATION: 'Circulation',
  ACCESS: 'Access',
  OPERATIONAL: 'Operational',
  UNCLASSIFIED: 'Unclassified',
});

const KIND_LABEL = Object.freeze({
  CAMPUS_CENTER: 'Campus centre',
  BOUNDARY: 'Campus boundary',
  BUILDING: 'Building',
  ROAD: 'Road',
  PATH: 'Path',
  GATE: 'Gate',
  LANDMARK: 'Landmark',
  FACILITY: 'Facility',
  OPERATIONAL_POINT: 'Operational point',
});

/**
 * UI LAYER — what the operator clicked.
 *
 * ── The rule this component enforces (§35) ────────────────────────────────
 * Only fields that actually exist are rendered. There is no "Nearby:" section
 * inventing adjacency, no department inferred from a position, no metadata
 * filled in to make the card look complete. A card with two rows is the
 * correct card when the record has two facts.
 *
 * Every card states its PROVENANCE and whether the geometry was VERIFIED,
 * because a basemap building and a surveyed campus building look identical
 * once they are both rectangles on a screen (§58).
 */
export function CampusFeatureCard({ feature, onClose, onFocus }) {
  if (!feature) return null;

  const isVendor = feature.provenance === PROVENANCE.VENDOR_BASEMAP;
  const isOpenData = feature.provenance === PROVENANCE.OPEN_DATA_IMPORT;
  const isUserSupplied = feature.provenance === PROVENANCE.USER_SUPPLIED;
  const verified = feature.verification === VERIFICATION.VERIFIED;
  const metadata = feature.metadata && typeof feature.metadata === 'object' ? feature.metadata : {};

  const rows = [
    feature.kind ? ['Kind', KIND_LABEL[feature.kind] || feature.kind] : null,
    feature.category ? ['Type', CATEGORY_LABEL[feature.category] || feature.category] : null,
    // MEASURED height only. The extrusion's `renderHeight` never appears under
    // this label — it is reported by the importer as a "Drawn height" line in
    // `metadata`, with the basis it was derived from spelled out, so a drawing
    // decision can never be read off this card as a building's dimensions (§8).
    typeof feature.height === 'number' ? ['Height (measured)', `${feature.height} m`] : null,
    feature.shortName ? ['Short name', feature.shortName] : null,
    ...Object.entries(metadata).map(([k, v]) => [k, String(v)]),
  ].filter(Boolean);

  return (
    <div className="map-feature-card" role="dialog" aria-label={`Details for ${feature.name}`}>
      <div className="map-feature-card__head">
        <div>
          <div className="map-feature-card__name">{feature.name}</div>
          <div className="map-feature-card__kind">{isVendor ? 'Basemap feature' : 'Campus feature'}</div>
        </div>
        <button type="button" className="map-feature-card__close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>

      {rows.length > 0 && (
        <dl className="map-feature-card__grid">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className={`map-feature-card__provenance${verified ? ' is-verified' : ''}`}>
        <div className="map-feature-card__provenance-head">
          <span>{PROVENANCE_LABEL[feature.provenance] || feature.provenance}</span>
          <span className="map-feature-card__badge">{verified ? 'VERIFIED' : 'NOT VERIFIED'}</span>
        </div>
        <p className="map-feature-card__source">{feature.source}</p>
        {isVendor && (
          <p className="map-feature-card__warn">
            Third-party geometry shown for city context. It is not a survey of this campus and must not be
            treated as one.
          </p>
        )}
        {isOpenData && (
          <p className="map-feature-card__warn">
            Community-mapped open data. The footprint and the name are OpenStreetMap&apos;s; nothing here has
            been checked against the physical site, so it must not be treated as a survey.
          </p>
        )}
        {isUserSupplied && (
          <p className="map-feature-card__warn">
            Supplied from local knowledge — a person pointing at where this is. It is not surveyed, not
            official RNSIT data and not verified.
            {feature.geometryRole === 'POINT_LOCATION' && ' This is a location only: its shape, extent and height are unknown.'}
          </p>
        )}
      </div>

      {typeof onFocus === 'function' && !isVendor && (
        <button type="button" className="map-feature-card__focus" onClick={onFocus}>
          Focus on map
        </button>
      )}
    </div>
  );
}
