import React, { useId, useState } from 'react';

import { STATION_STATE, STATION_STATE_META } from '../../charging/stationModel.js';

const STATION_KEY = [STATION_STATE.AVAILABLE, STATION_STATE.OCCUPIED, STATION_STATE.QUEUED, STATION_STATE.INACTIVE, STATION_STATE.UNAVAILABLE];

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
 *
 * ── Collapsed means collapsed ─────────────────────────────────────────────
 * The header used to toggle only the short key rows at the bottom, while the zone section —
 * most of the panel — was rendered outside the toggle and never went away: clicking to
 * minimise the legend made it LONGER (2026-10-23). Now the header collapses the whole body to
 * the header bar, which stays on screen as the way back. Expanded state can be owned by the
 * page (`expanded` + `onExpandedChange`), which frames the zone preview clear of the panel.
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
  /** Every station the simulator reports (`stationSummaries`), or [] — see ChargingStationCard. */
  stations = [],
  /** False when there is no simulator charging report at all (not a simulated deployment, or not loaded). */
  chargingReported = false,
  /** True when this account may not read the simulator report at all (RBAC: SUPER_ADMIN only). */
  chargingRestricted = false,
  selectedStationId = null,
  onPickStation,
  /** DTARO — the zone key (`ZoneLegendSection`), shown whether or not the legend is expanded. */
  zoneSection = null,
  /**
   * DTARO — `{ text, color }` naming the alert zone at the map centre, in the legend's header so
   * it stays readable while the legend is collapsed (on a phone the zone key is then hidden).
   */
  headerNote = null,
  /** Controlled expanded state; uncontrolled (starting expanded) when omitted. */
  expanded,
  onExpandedChange,
}) {
  const [ownOpen, setOwnOpen] = useState(true);
  const open = typeof expanded === 'boolean' ? expanded : ownOpen;
  const setOpen = (next) => {
    if (typeof expanded !== 'boolean') setOwnOpen(next);
    onExpandedChange?.(next);
  };
  const bodyId = useId();
  const hasCampusGeometry = campusFeatureCount > 1; // the centre point alone is not geometry

  const swatch = (style) => <span className="map-legend__swatch" style={style} />;

  return (
    <div className={`map-legend${open ? ' is-open' : ' is-collapsed'}`} aria-label="Map legend">
      <button
        type="button"
        className="map-legend__head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        title={open ? 'Minimise the legend' : 'Show the legend'}
      >
        <span>Legend</span>
        {headerNote && (
          <span className="map-legend__note" style={headerNote.color ? { '--zone-color': headerNote.color } : undefined}>
            {headerNote.text}
          </span>
        )}
        <span className="map-legend__toggle-hint">
          {open ? 'Hide' : 'Show'}
          <span aria-hidden="true">{open ? ' ▾' : ' ▸'}</span>
        </span>
      </button>

      {open && (
        <div id={bodyId} className="map-legend__body">
          {zoneSection}

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

          <div className="map-legend__divider" />
          {chargingReported ? (
            <>
              <div className="map-legend__row">
                <span className="map-legend__swatch map-legend__swatch--charger-route" />
                <span>Route to charger (simulated robot)</span>
              </div>
              {STATION_KEY.map((state) => (
                <div className="map-legend__row" key={state}>
                  <span
                    className="map-legend__station-dot"
                    style={{ '--station-state': STATION_STATE_META[state].color }}
                  />
                  <span>Charging station — {STATION_STATE_META[state].label.toLowerCase()}</span>
                </div>
              ))}
              {stations.length > 0 && (
                <div className="map-legend__stations" role="list" aria-label="Charging stations">
                  {stations.map((station) => (
                    <div role="listitem" key={station.chargerId}>
                      <button
                        type="button"
                        className="map-legend__station"
                        aria-pressed={station.chargerId === selectedStationId}
                        disabled={!station.lngLat}
                        title={station.lngLat ? 'Show this station' : 'No coordinate supplied — not on the map'}
                        onClick={() => onPickStation?.(station.chargerId)}
                      >
                        <span
                          className="map-legend__station-dot"
                          style={{ '--station-state': (STATION_STATE_META[station.state] || STATION_STATE_META.INACTIVE).color }}
                        />
                        <span className="map-legend__station-text">
                          <span className="map-legend__station-name">{station.name}</span>
                          <span className="map-legend__station-status">
                            {station.lngLat ? station.status : `${station.status} · not placed`}
                          </span>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="map-legend__row">
              <span>{chargingRestricted ? 'Charging stations: visible to super administrators only' : 'Charging stations: no simulator charging report'}</span>
            </div>
          )}

          {hasCampusGeometry && (
            <>
              <div className="map-legend__divider" />
              <div className="map-legend__row">
                {swatch({
                  background: `repeating-linear-gradient(90deg, ${theme.campus.boundaryLine} 0 5px, transparent 5px 8px)`,
                  height: '0.1875rem',
                })}
                <span>Campus boundary — tasks and routes stay inside</span>
              </div>
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
        </div>
      )}
    </div>
  );
}
