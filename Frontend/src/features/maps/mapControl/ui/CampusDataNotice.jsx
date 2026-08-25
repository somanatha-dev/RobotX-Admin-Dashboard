import React, { useState } from 'react';

/**
 * UI LAYER — the map states where its geometry came from, and what it is not (§35).
 *
 * This component exists because the most dangerous failure available to a
 * campus map is not an ugly one. It is a map that renders convincing buildings
 * at campus zoom and lets an operator believe they are looking at a survey of
 * the campus.
 *
 * Every line below is fed from the selected campus's own import result. Nothing
 * here knows which campus is on screen, so a campus the owner has confirmed and
 * a campus nobody has visited each get the sentence that is true of them.
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
  /** Imported features that fall outside the campus boundary (§46). */
  outsideBoundaryCount,
  /** The owner's verification record for this campus, or null (§3A). */
  verificationRecord,
}) {
  const [open, setOpen] = useState(false);
  const missingList = Array.isArray(missing) ? missing : [];

  // With geometry present the notice is always worth showing — the provenance
  // is the point of it. Without geometry it only appears if there is something
  // to report.
  if (!hasCampusGeometry && missingList.length === 0 && !rejectedCount) return null;

  const ownerVerified = Boolean(verificationRecord);

  // ── The line this component leads with (§3A) ─────────────────────────────
  // It used to be "Campus geometry: OpenStreetMap · Unverified", which was the
  // honest summary while nobody had checked anything. It is no longer true, and
  // a standing "Unverified" over a campus the owner has confirmed is not
  // caution — it is a false statement that also trains the operator to ignore
  // the one banner that will matter when something really is unverified. So the
  // summary states what IS known and the body keeps every remaining gap by name.
  const summary = hasCampusGeometry
    ? ownerVerified
      ? `Campus: ${geometrySource || 'imported dataset'} · verified by project owner`
      : `Campus geometry: ${geometrySource || 'imported dataset'} · Unverified`
    : `${campusName || 'This campus'}: no campus geometry`;

  return (
    <div className={`map-data-notice${open ? ' is-open' : ''}${ownerVerified ? ' is-verified' : ''}`}>
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
                Source: {geometrySource || 'imported dataset'}
                <br />
                Campus verification:{' '}
                <strong>
                  {ownerVerified
                    ? `${verificationRecord.verifiedBy}, ${verificationRecord.verifiedOn}`
                    : 'Unverified'}
                </strong>
              </p>
              <p>
                The {featureCount ? `${featureCount} ` : ''}campus features — buildings, roads, paths,
                landmarks — come from {geometrySource || 'the imported dataset'} and are shown as
                <strong> the campus itself</strong>.{' '}
                {ownerVerified
                  ? 'The project owner has confirmed them against the site. Where each coordinate came from is unchanged and still shown on every card: origin and verification are two separate facts and the map keeps both.'
                  : 'They are real community-mapped data, unchecked against the physical site — being present in OpenStreetMap is not a verification.'}
              </p>
              {outsideBoundaryCount > 0 && (
                <p className="map-data-notice__notes">
                  {outsideBoundaryCount} imported feature(s) fall <strong>outside the campus boundary</strong>
                  {' '}— an extract is a bounding box, not a campus. They are drawn because they are real,
                  correctly-attributed geometry, and each one says so on its details card. Nothing was
                  deleted to tidy the picture.
                </p>
              )}
              {ownerVerified && (
                <>
                  <div className="map-data-notice__label">What that confirmation does not cover</div>
                  <ul>
                    {verificationRecord.doesNotCover.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {supplemental && supplemental.importedFeatureCount > 0 && (
                <>
                  <div className="map-data-notice__label">Also on this map</div>
                  <p>
                    {supplemental.importedFeatureCount} <strong>user-supplied locations</strong> — a gate,
                    playgrounds, parking, departments and facilities OpenStreetMap does not carry. They are{' '}
                    <strong>point locations only</strong>: their position is
                    {ownerVerified ? ' confirmed' : ' supplied from local knowledge'}, and their shape,
                    extent and height are unknown. No footprint or volume is drawn from them, so they appear
                    as small markers rather than as buildings.
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
