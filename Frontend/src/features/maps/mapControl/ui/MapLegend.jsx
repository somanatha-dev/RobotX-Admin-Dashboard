import React, { useState } from 'react';

/**
 * UI LAYER — reads the visual hierarchy back to the operator, and reports what
 * the environment layer actually managed to install (§23: a silently flat map
 * is worse than a map that says it is flat).
 *
 * ── Why it collapses (§37) ────────────────────────────────────────────────
 * A legend that explains every layer is a legend that covers the map. Rows for
 * campus geometry only appear when this campus HAS campus geometry, so on a
 * campus with none the legend stays the four operational rows it always was
 * rather than listing things that are not on screen.
 */
export function MapLegend({
  theme,
  terrainActive,
  buildings3dActive,
  robotCount,
  campusFeatureCount,
  campusName,
  geometrySource,
  /** e.g. "verified by owner" — the calm form, not a warning (§3A). */
  verificationLabel,
}) {
  const [open, setOpen] = useState(false);
  const hasCampusGeometry = campusFeatureCount > 1; // the centre point alone is not geometry

  const swatch = (style) => <span className="map-legend__swatch" style={style} />;

  return (
    <div className="map-legend" aria-label="Map legend">
      <button type="button" className="map-legend__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>Legend</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <>
          <div className="map-legend__row">
            <span className="map-legend__swatch map-legend__swatch--robot" />
            <span>Robot — 2D marker, arrow = heading</span>
          </div>
          <div className="map-legend__row">
            {swatch({ background: theme.routes.todo, height: '0.1875rem' })}
            <span>Route ahead</span>
          </div>
          <div className="map-legend__row">
            {swatch({ background: theme.routes.done, height: '0.1875rem', opacity: 0.55 })}
            <span>Route travelled</span>
          </div>
          <div className="map-legend__row">
            <span className="map-legend__swatch map-legend__swatch--pin" />
            <span>Pickup / drop</span>
          </div>

          {hasCampusGeometry && (
            <>
              <div className="map-legend__divider" />
              <div className="map-legend__row">
                {swatch({ background: theme.campus.buildings.ACADEMIC, height: '0.625rem', borderRadius: '2px' })}
                <span>Campus building (colour = type)</span>
              </div>
              <div className="map-legend__row">
                {swatch({ background: theme.campus.ground.SPORTS, height: '0.5rem', borderRadius: '2px' })}
                <span>Ground / sports area</span>
              </div>
              <div className="map-legend__row">
                {/* Carriageway AND casing. A campus road is dark-in-bright by
                    day and bright-in-dark at night, and a swatch showing only
                    the fill would disagree with the map in one of those two
                    directions — which is exactly what it used to do. */}
                <span
                  className="map-legend__swatch map-legend__swatch--road"
                  style={{
                    background: theme.roads.main.color,
                    height: '0.25rem',
                    '--legend-road-casing': theme.roads.main.casing,
                  }}
                />
                <span>Campus road</span>
              </div>
              <div className="map-legend__row">
                {swatch({
                  background: `repeating-linear-gradient(90deg, ${theme.roads.path.color} 0 4px, transparent 4px 7px)`,
                  height: '0.1875rem',
                })}
                <span>Pedestrian path</span>
              </div>
              <div className="map-legend__row">
                {swatch({
                  background: `repeating-linear-gradient(90deg, ${theme.roads.steps.color} 0 2px, transparent 2px 5px)`,
                  height: '0.25rem',
                })}
                <span>Steps — not driveable</span>
              </div>
              <div className="map-legend__row">
                {swatch({
                  background: theme.campus.gate,
                  border: `2px solid ${theme.campus.gateEdge}`,
                  height: '0.625rem',
                  width: '0.625rem',
                  borderRadius: '50%',
                  flex: '0 0 auto',
                })}
                <span>Gate — campus entrance</span>
              </div>
              <div className="map-legend__row">
                {/* Operational POIs are the SAME colour as any other campus
                    location and differ only in size (§3C). A legend row that
                    invented a second colour would describe a map that does not
                    exist. */}
                {swatch({
                  background: theme.campus.buildingRoof,
                  border: `1.5px solid ${theme.campus.buildingEdge}`,
                  height: '0.6875rem',
                  width: '0.6875rem',
                  borderRadius: '50%',
                  flex: '0 0 auto',
                })}
                <span>Operational location — parking, food, department</span>
              </div>
              <div className="map-legend__row">
                {swatch({
                  background: theme.campus.buildingRoof,
                  border: `1.5px solid ${theme.campus.buildingEdge}`,
                  height: '0.5rem',
                  width: '0.5rem',
                  borderRadius: '50%',
                  flex: '0 0 auto',
                })}
                <span>Campus POI (point only)</span>
              </div>
              <div className="map-legend__row">
                {swatch({
                  background: theme.campus.buildingHighlight,
                  height: '0.625rem',
                  borderRadius: '2px',
                })}
                <span>Selected location</span>
              </div>
            </>
          )}

          <div className="map-legend__meta">
            {robotCount} unit{robotCount === 1 ? '' : 's'} · {buildings3dActive ? '3D buildings' : 'flat buildings'} ·{' '}
            {terrainActive ? 'terrain on' : 'terrain off'}
            {campusName ? (
              <>
                <br />
                {hasCampusGeometry
                  ? `${campusFeatureCount} campus features · ${geometrySource || 'imported data'} · ${
                      verificationLabel || 'unverified'
                    }`
                  : 'Campus geometry: centre point only — buildings shown are basemap context'}
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
