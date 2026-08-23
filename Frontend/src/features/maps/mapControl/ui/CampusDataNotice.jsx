import React, { useState } from 'react';

/**
 * UI LAYER — the map states where its geometry came from, and what it is not (§35).
 *
 * This component exists because the most dangerous failure available to a
 * campus map is not an ugly one. It is a map that renders convincing buildings
 * at campus zoom and lets an operator believe they are looking at a survey of
 * RNSIT.
 *
 * That risk did not go away when real geometry arrived — it got sharper. Generic
 * vendor blocks at least LOOKED generic. Correctly-shaped, correctly-named OSM
 * footprints look exactly like a survey, and are not one. So the notice now
 * leads with the provenance rather than with the absence:
 *
 *      Campus geometry: OpenStreetMap
 *      Verification: Unverified
 *
 * It collapses to a single line so it can be lived with, and it offers no way
 * to dismiss it permanently.
 */
export function CampusDataNotice({
  campusName,
  geometrySource,
  hasCampusGeometry,
  featureCount,
  missing,
  notes,
  rejectedCount,
  excludedCount,
  vendorClipActive,
  centreWithinBoundary,
  supplemental,
}) {
  const [open, setOpen] = useState(false);
  const missingList = Array.isArray(missing) ? missing : [];

  // With geometry present the notice is always worth showing — the verification
  // status is the point of it. Without geometry it only appears if there is
  // something to report.
  if (!hasCampusGeometry && missingList.length === 0 && !rejectedCount) return null;

  const summary = hasCampusGeometry
    ? `Campus geometry: ${geometrySource || 'imported dataset'} · Unverified`
    : `${campusName || 'This campus'}: no campus geometry`;

  return (
    <div className={`map-data-notice${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="map-data-notice__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="map-data-notice__dot" aria-hidden="true" />
        <span>{summary}</span>
        <span className="map-data-notice__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="map-data-notice__body">
          {hasCampusGeometry ? (
            <>
              <p>
                <strong>{campusName || 'This campus'}</strong>
                <br />
                Campus geometry: {geometrySource || 'imported dataset'}
                <br />
                Verification: <strong>Unverified</strong>
              </p>
              <p>
                The {featureCount ? `${featureCount} ` : ''}campus features drawn inside the boundary —
                buildings, roads, paths, landmarks — come from OpenStreetMap and are shown as
                <strong> the campus itself</strong>. They are real community-mapped data. Nothing in this
                system has checked them against the physical site, and no building carries a measured
                height: extrusion heights are derived from floor counts where the source has them and from a
                conservative default otherwise. Click any feature to see which.
              </p>
              {supplemental && supplemental.importedFeatureCount > 0 && (
                <>
                  <div className="map-data-notice__label">Also on this map</div>
                  <p>
                    {supplemental.importedFeatureCount} <strong>user-supplied locations</strong> — a gate,
                    playgrounds, parking, departments and facilities OpenStreetMap does not carry. These are
                    the <strong>least verified</strong> thing here: someone who knows the campus pointing at
                    where a thing is. They are <strong>point locations only</strong> — no footprint, extent
                    or height is drawn from them, and they are shown as small markers rather than buildings.
                    {supplemental.outsideCount > 0 && (
                      <>
                        {' '}
                        {supplemental.outsideCount} of them fall outside the campus boundary and
                        {supplemental.uncertainCount > 0 ? ` ${supplemental.uncertainCount} are too close to it to call;` : ';'}{' '}
                        each one says which on its details card.
                      </>
                    )}
                  </p>
                  {supplemental.possibleDuplicates?.length > 0 && (
                    <p className="map-data-notice__notes">
                      {supplemental.possibleDuplicates.length} supplied location(s) sit close to a similar
                      OpenStreetMap feature and may describe the same place. Both are shown — nothing has been
                      merged without matching names, and nothing has been moved.
                    </p>
                  )}
                </>
              )}

              <p className="map-data-notice__notes">
                Buildings outside the boundary are the Mapbox basemap&apos;s — surrounding city context, not
                part of this campus.
                {vendorClipActive === false && (
                  <>
                    {' '}
                    This build could not clip the basemap&apos;s own 3D models inside the boundary, so a
                    campus building may appear twice.
                  </>
                )}
              </p>
              {centreWithinBoundary === false && (
                <p className="map-data-notice__rejected">
                  The campus centre recorded in the database falls OUTSIDE this boundary. One of the two is
                  wrong — the geometry has not been moved to hide the disagreement.
                </p>
              )}
            </>
          ) : (
            <p>
              The buildings and roads visible at campus zoom come from the Mapbox basemap (OpenStreetMap
              contributors). They are real third-party geometry shown as city context — they are
              <strong> not</strong> a survey of this campus, and building identities are not known.
            </p>
          )}

          {missingList.length > 0 && (
            <>
              <div className="map-data-notice__label">Still missing</div>
              <ul>
                {missingList.map((m) => (
                  <li key={m.id}>{m.label}</li>
                ))}
              </ul>
            </>
          )}

          {excludedCount > 0 && (
            <p className="map-data-notice__notes">
              {excludedCount} source feature(s) were not imported — duplicates of another feature, or tagged
              in a way this map has no rule for. Nothing was invented to replace them.
            </p>
          )}

          {rejectedCount > 0 && (
            <p className="map-data-notice__rejected">
              {rejectedCount} campus feature(s) failed validation and were not rendered.
            </p>
          )}

          {notes && <p className="map-data-notice__notes">{notes}</p>}
        </div>
      )}
    </div>
  );
}
