import React from 'react';

import {
  GATE_ACCESS_CHANNELS,
  PROVENANCE,
  VERIFICATION,
  gateAccessIsKnown,
  isVerified,
} from '../../campus/campusSchema.js';

const PROVENANCE_LABEL = Object.freeze({
  SURVEYED: 'Surveyed',
  SEED_RECORD: 'Database record',
  OPERATIONAL_RECORD: 'Operational record',
  VENDOR_BASEMAP: 'Basemap (OpenStreetMap via Mapbox)',
  OPEN_DATA_IMPORT: 'OpenStreetMap',
  USER_SUPPLIED: 'User supplied',
});

/**
 * How each verification state reads to an operator (§3A).
 *
 * The wording is the deliverable here. "NOT VERIFIED" stamped on a feature the
 * project owner has personally confirmed is not caution, it is a false
 * statement — and a map that shouts it on every card trains an operator to stop
 * reading the badge at all, which costs the warning its meaning on the one
 * feature that still needs it.
 */
const VERIFICATION_LABEL = Object.freeze({
  VERIFIED: 'Verified — survey',
  VERIFIED_BY_USER: 'Verified by project owner',
  NOT_VERIFIED: 'Not verified',
});

const ROLE_LABEL = Object.freeze({
  GATE: 'Gate',
  DOCKING_STATION: 'Docking station',
  CHARGING_POINT: 'Charging point',
  PICKUP_DROP_POINT: 'Pickup / drop point',
  PARKING: 'Parking',
  FOOD_SERVICE: 'Food service',
  DEPARTMENT: 'Department',
  SERVICE_POINT: 'Service point',
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
  const verified = isVerified(feature);
  const ownerVerified = feature.verification === VERIFICATION.VERIFIED_BY_USER;
  const metadata = feature.metadata && typeof feature.metadata === 'object' ? feature.metadata : {};
  const accessKnown = gateAccessIsKnown(feature.access);

  // §3N asks for coordinates on a campus feature. Shown for a POINT LOCATION,
  // where the coordinate IS the feature; a footprint has no single coordinate
  // and printing its centroid would be inventing a position for it.
  const point = feature.geometry?.type === 'Point' ? feature.geometry.coordinates : null;

  const rows = [
    feature.kind ? ['Kind', KIND_LABEL[feature.kind] || feature.kind] : null,
    feature.category ? ['Type', CATEGORY_LABEL[feature.category] || feature.category] : null,
    ROLE_LABEL[feature.operationalRole] ? ['Operational role', ROLE_LABEL[feature.operationalRole]] : null,
    point ? ['Coordinates', `${Number(point[1]).toFixed(6)}, ${Number(point[0]).toFixed(6)}`] : null,
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

      {/* ── Gate access (§3B) ──────────────────────────────────────────────
          A gate's access rules are the one property here with routing
          consequences, so their ABSENCE is stated rather than left to be
          inferred from a missing section. Every channel is listed; none is
          invented. */}
      {feature.access && (
        <div className="map-feature-card__access">
          <div className="map-feature-card__access-head">Access</div>
          {accessKnown ? (
            <dl className="map-feature-card__access-grid">
              {GATE_ACCESS_CHANNELS.map((channel) => (
                <div key={channel}>
                  <dt>{channel}</dt>
                  <dd>{String(feature.access[channel] || 'UNKNOWN').toLowerCase()}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="map-feature-card__access-note">
              Not recorded. Vehicle, pedestrian, service and emergency access, and whether this gate is
              open, are all unknown — no source carries them. The campus model holds all four fields so
              they can be filled in; nothing here has guessed at them, and no route uses this gate.
            </p>
          )}
        </div>
      )}

      {/* ── Provenance and verification, as TWO facts (§3A) ────────────────
          "Where the coordinates came from" and "whether anyone checked them"
          are independent, and this card is where a reader most needs to see
          that they are. A feature can be OpenStreetMap-sourced AND confirmed by
          the person who runs the site; collapsing that into one badge is how a
          verified feature ends up displaying "NOT VERIFIED". */}
      <div className={`map-feature-card__provenance${verified ? ' is-verified' : ''}`}>
        <dl className="map-feature-card__provenance-grid">
          <div>
            <dt>Source</dt>
            <dd>{PROVENANCE_LABEL[feature.provenance] || feature.provenance}</dd>
          </div>
          <div>
            <dt>Campus verification</dt>
            <dd>{VERIFICATION_LABEL[feature.verification] || 'Not verified'}</dd>
          </div>
        </dl>
        {ownerVerified && feature.verifiedOn && (
          <p className="map-feature-card__checked">
            Confirmed against the site by {feature.verifiedBy || 'the project owner'} on {feature.verifiedOn}.
            The geometry still originates from {PROVENANCE_LABEL[feature.provenance] || feature.provenance}.
          </p>
        )}
        <p className="map-feature-card__source">{feature.source}</p>
        {isVendor && (
          <p className="map-feature-card__warn">
            Third-party geometry shown for city context. It is not part of this campus and nobody has
            checked it — building identities are not in the basemap data.
          </p>
        )}
        {/* The remaining caveats are the ones an owner's confirmation genuinely
            does NOT settle. They are narrower than the blanket warnings they
            replace, and that is the point: a caution that is always on is a
            caution nobody reads. */}
        {isOpenData && ownerVerified && (
          <p className="map-feature-card__warn">
            The outline and its vertices are OpenStreetMap&apos;s. The owner confirmed what this feature is
            and where it is; its geometry has not been measured against a survey.
          </p>
        )}
        {isOpenData && !verified && (
          <p className="map-feature-card__warn">
            Community-mapped open data, unchecked against the physical site.
          </p>
        )}
        {isUserSupplied && (
          <p className="map-feature-card__warn">
            {ownerVerified
              ? 'Supplied and confirmed from local knowledge of the site. It is not surveyed and not official RNSIT data.'
              : 'Supplied from local knowledge — a person pointing at where this is. Not surveyed, not official RNSIT data, not verified.'}
            {feature.geometryRole === 'POINT_LOCATION' &&
              ' This is a location only: its shape, extent and height are unknown.'}
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
