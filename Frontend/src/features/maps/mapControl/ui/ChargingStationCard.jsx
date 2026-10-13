import React from 'react';

import { STATION_STATE, STATION_STATE_META } from '../../charging/stationModel.js';

/**
 * UI LAYER — the charging station the operator selected (on the map, or from the legend).
 *
 * Same rule as the campus feature card: only what the simulator's report states. The
 * station's position is labelled for what it is — the operational coordinate of a usable
 * station, or the DECLARED coordinate of one that cannot serve robots (shown, never used) —
 * and the simulation caveat is always present, because a simulated charging session says
 * nothing about real charging hardware.
 */
export function ChargingStationCard({ station, onClose, onFocus }) {
  if (!station) return null;
  const meta = STATION_STATE_META[station.state] || STATION_STATE_META.INACTIVE;
  const operational = meta.operational;

  const rows = [
    ['State', meta.label],
    operational && station.plugCount !== null ? ['Plugs', `${station.active ?? 0} of ${station.plugCount} in use`] : null,
    operational ? ['Charging now', String(station.chargingNow)] : null,
    operational && station.queued !== null ? ['Queued', String(station.queued)] : null,
    station.lngLat
      ? [
          station.positionKind === 'OPERATIONAL' ? 'Coordinates' : 'Declared coordinates',
          `${Number(station.lngLat[1]).toFixed(6)}, ${Number(station.lngLat[0]).toFixed(6)}`,
        ]
      : ['Coordinates', 'None supplied — not placed on the map'],
    station.approved === null ? null : ['Owner approval', station.approved ? 'Approved' : 'Not approved'],
  ].filter(Boolean);

  return (
    // A non-modal information panel beside the map — the map stays interactive and focus is not
    // moved — so it is a labelled region, not a dialog (which promises focus management it does
    // not have).
    <div className="map-feature-card map-station-card" role="region" aria-label={`Charging station ${station.name}`}>
      <div className="map-feature-card__head">
        <div>
          <div className="map-feature-card__name">{station.name}</div>
          <div className="map-feature-card__kind">
            {station.isDepot ? 'Depot charger' : 'Charging station'} · simulation
          </div>
        </div>
        <button type="button" className="map-feature-card__close" onClick={onClose} aria-label="Close station details">
          ×
        </button>
      </div>

      <div className="map-station-card__state" style={{ '--station-state': meta.color }}>
        <span className="map-station-card__dot" aria-hidden="true" />
        <span>{station.status || meta.label}</span>
      </div>

      <dl className="map-feature-card__grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {!operational && station.reasons.length > 0 && (
        <p className="map-feature-card__warn">
          {station.state === STATION_STATE.INACTIVE
            ? 'Not an operational charger: the owner has not approved it, so no robot is sent here.'
            : 'Not an operational charger.'}{' '}
          Reported reasons: {station.reasons.join(', ')}.
        </p>
      )}

      <p className="map-feature-card__source">
        From the simulator&apos;s charging report. Simulated charging is not evidence of physical charging
        performance; the 3D installation is a map symbol centred on the coordinate, not a survey.
      </p>

      {station.lngLat && (
        <button type="button" className="map-feature-card__focus" onClick={onFocus}>
          Focus on station
        </button>
      )}
    </div>
  );
}
