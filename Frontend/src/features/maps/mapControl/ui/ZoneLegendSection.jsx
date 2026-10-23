import React from 'react';

import { ZONE_KIND, ZONE_VIEW, zoneStatusSentence } from '../../dtaro/zoneModel.js';

/**
 * UI LAYER — the zone key, inside the map legend. Two kinds of area, never mixed:
 *
 *   · ZONES — what the map's zone view (`ZONE_VIEW`, switched at the top of the map) draws:
 *     nothing in the NORMAL map (a one-line note says so), the four-zone G4 PROPOSAL preview,
 *     or — for diagnostics, reached from the proposal's key — the PUBLISHED map the server
 *     pins, the one alert delivery uses. One row per zone, with a visibility toggle.
 *   · CAMPUS AREAS — named buildings and grounds from the campus's own classified outlines,
 *     tinted so the campus reads by area. Visual only: they route and alert nothing, and the
 *     key says so. What the data does not hold (no Library, point-only playgrounds) is stated.
 */
export function ZoneLegendSection({
  status,
  zones,
  hiddenZones,
  onToggleZone,
  onShowAll,
  spatialVersion = null,
  preview = null,
  /** `ZONE_VIEW` — which zones the map is drawing. */
  mode = ZONE_VIEW.PUBLISHED,
  onModeChange,
  areaRows = [],
  areasOn = true,
  onToggleAreas,
  areaNotes = [],
  areaSource = null,
  /** Whether the server delivers obstacle alerts by these zones (`DTARO_ZONE_ALERTS_ENABLED`). */
  alertsEnabled = false,
  /** Why the zone map could not be loaded (`HTTP 403`, `NETWORK`), when it could not. */
  loadError = null,
  /** The campus perimeter's line colour (`theme.campus.boundaryLine`), when a campus is drawn. */
  boundaryColor = null,
}) {
  const sentence = zoneStatusSentence(status);
  const normal = mode === ZONE_VIEW.NORMAL;
  const previewOn = mode === ZONE_VIEW.PROPOSAL && Boolean(preview);
  const published = mode === ZONE_VIEW.PUBLISHED;
  const shown = previewOn ? [...preview.zones, ...(preview.unresolved ? [preview.unresolved] : [])] : published ? zones : [];
  const anyHidden = shown.some((z) => hiddenZones.has(z.key));
  // With one published zone the whole campus is that zone — said on its row, not in a paragraph.
  const wholeCampus = published && zones.length === 1;
  const layoutName = preview?.layout ? `${preview.layout} ` : '';

  return (
    <div className="map-zone-legend" role="group" aria-label="Zones and campus areas">
      <div className="map-zone-legend__head">
        <span>
          {normal ? 'Zones — hidden (normal map)' : previewOn ? `Zones — ${layoutName}proposal preview` : preview ? 'Alert zones — published map (diagnostic)' : 'Alert zones — published map'}
        </span>
        {published && spatialVersion !== null && <span className="map-zone-legend__meta">v{String(spatialVersion)}</span>}
      </div>

      {normal && (
        <p className="map-zone-legend__muted">
          No zone shading, outlines or labels on the normal map. Robots, routes, stations and obstacle alerts are unchanged.
          {preview && (
            <>
              {' '}
              <button type="button" className="map-zone-legend__link" onClick={() => onModeChange?.(ZONE_VIEW.PROPOSAL)}>
                Show zones
              </button>
            </>
          )}
        </p>
      )}

      {previewOn && (
        <p className="map-zone-legend__warn">
          {preview.layout ? `${preview.layout} ` : ''}PROPOSAL
          {preview.validated ? ' — validated offline' : ''} — not approved, not published. Alerts still use the published
          map ({zones.length} zone{zones.length === 1 ? '' : 's'}, under Diagnostics below), not this.
        </p>
      )}

      {published && sentence && (
        <p className="map-zone-legend__muted">
          {sentence}
          {loadError ? ` (${loadError})` : ''}
        </p>
      )}

      {/* One published zone: say plainly that it is the whole campus, and that the proposal is
          not it — the coloured campus areas and the preview are not further zones. */}
      {wholeCampus && (
        <p className="map-zone-legend__muted">
          One operational zone is published for this campus. It covers all {zones[0].cellCount ?? ''} assigned
          cells, so every robot here is in it.
          {preview ? ` The ${preview.zones.length}-zone ${layoutName}layout is a proposal and is not in use.` : ''}
        </p>
      )}

      {published && zones.length > 0 && (
        <p className={`map-zone-legend__alerts${alertsEnabled ? ' is-on' : ''}`}>
          {alertsEnabled
            ? 'Obstacle alerts: on — an alert goes to the robots in the reporting robot’s zone.'
            : 'Obstacle alerts: off on this server — the zone is shown for reference only.'}
        </p>
      )}

      {shown.length > 0 && (
        <ul className="map-zone-legend__list">
          {shown.map((zone) => {
            const visible = !hiddenZones.has(zone.key);
            return (
              <li key={zone.key}>
                <button
                  type="button"
                  className="map-zone-legend__row"
                  aria-pressed={visible}
                  title={visible ? 'Hide this zone' : 'Show this zone'}
                  onClick={() => onToggleZone(zone.key)}
                >
                  <span
                    className={`map-zone-legend__swatch is-zone${zone.kind === ZONE_KIND.LIVE ? '' : ' is-dashed'}`}
                    style={{ '--zone-color': zone.color }}
                    aria-hidden="true"
                  />
                  <span
                    className="map-zone-legend__name"
                    title={wholeCampus ? 'One published alert zone covers this campus: every robot here receives its alerts.' : undefined}
                  >
                    {zone.kind === ZONE_KIND.PREVIEW ? `${zone.name} · ${zone.zoneId}` : zone.name}
                    {Number.isFinite(zone.cellCount) && (
                      <span className="map-zone-legend__sub">
                        {zone.cellCount} cells{wholeCampus ? ' · whole campus' : ''}
                        {zone.kind === ZONE_KIND.PREVIEW && zone.contents ? ` · ${zone.contents}` : ''}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* The campus perimeter is a different line from the alert zone, and the one that limits
          robots: the zone is whole map cells, so its outline runs outside the campus in places. */}
      {boundaryColor && shown.length > 0 && (
        <div className="map-zone-legend__boundary">
          <div className="map-zone-legend__boundary-row">
            <span className="map-zone-legend__swatch is-boundary" style={{ '--boundary-color': boundaryColor }} aria-hidden="true" />
            <span>Campus boundary (dashed) — robots operate and route only inside it</span>
          </div>
          <p className="map-zone-legend__muted">
            {previewOn
              ? 'Each proposed zone is built from whole map cells, so its dashed outline runs outside the campus boundary in places. The boundary itself is unchanged.'
              : 'The alert zone is built from whole map cells, so its outline runs outside the campus boundary in places. That does not widen where robots may go.'}
          </p>
        </div>
      )}

      <div className="map-zone-legend__actions">
        {anyHidden && (
          <button type="button" className="map-zone-legend__link" onClick={onShowAll}>
            Show all
          </button>
        )}
        {/* The published map stays one click away for diagnostics, but off the main switch. */}
        {previewOn && (
          <button type="button" className="map-zone-legend__link is-diagnostic" onClick={() => onModeChange?.(ZONE_VIEW.PUBLISHED)}>
            Diagnostics: published alert map ({zones.length} zone{zones.length === 1 ? '' : 's'})
          </button>
        )}
        {published && preview && (
          <button type="button" className="map-zone-legend__link" onClick={() => onModeChange?.(ZONE_VIEW.PROPOSAL)}>
            Back to the {layoutName}proposal
          </button>
        )}
      </div>

      {areaRows.length > 0 && (
        <div className="map-zone-legend__areas" role="group" aria-label="Campus areas (visual only)">
          <div className="map-zone-legend__head">
            <span>Campus areas — visual only, not alert zones</span>
            <label className="map-zone-legend__toggle is-compact">
              <input type="checkbox" checked={areasOn} onChange={(e) => onToggleAreas(e.target.checked)} />
              <span>Show</span>
            </label>
          </div>
          {areasOn && (
            <>
              <ul className="map-zone-legend__chips" aria-label="Area colours">
                {areaRows.map((row) => (
                  <li key={row.group} className="map-zone-legend__chip">
                    <span
                      className="map-zone-legend__swatch is-area"
                      style={{ '--area-fill': row.fill, '--area-line': row.line }}
                      aria-hidden="true"
                    />
                    <span>{row.count > 1 ? `${row.label} ×${row.count}` : row.label}</span>
                  </li>
                ))}
              </ul>
              {areaNotes.length > 0 && (
                <details className="map-zone-legend__gaps">
                  <summary title={areaSource ? `Building and ground outlines — ${areaSource}` : undefined}>
                    Not in the data ({areaNotes.length})
                  </summary>
                  <ul className="map-zone-legend__notes">
                    {areaNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
