import React from 'react';

/**
 * FALLBACK LAYER (§23).
 *
 * If the map cannot be constructed at all — no WebGL, a lost context, a driver
 * that refuses — robots must not silently vanish. The same robot state that
 * feeds the map feeds this list, so the operator still sees every unit, its
 * identity, status, battery and coordinates.
 */
export function MapUnavailableFallback({ reason, robots }) {
  const list = Array.isArray(robots) ? robots : [];
  return (
    <div className="map-fallback">
      <div className="map-fallback__head">
        <div className="map-fallback__title">3D map unavailable</div>
        <div className="map-fallback__reason">{reason}</div>
      </div>
      <div className="map-fallback__list-title">Live units ({list.length})</div>
      <ul className="map-fallback__list">
        {list.map((r) => (
          <li key={r.robotId} className="map-fallback__item">
            <span className="map-fallback__item-id">{r.robotId}</span>
            <span>{String(r.status || 'UNKNOWN').toUpperCase()}</span>
            <span>{typeof r.battery === 'number' ? `${Math.round(r.battery)}%` : '—'}</span>
            <span className="map-fallback__item-pos">
              {typeof r.lat === 'number' && typeof r.lon === 'number'
                ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`
                : 'no position'}
            </span>
          </li>
        ))}
        {list.length === 0 && <li className="map-fallback__item">No units reporting.</li>}
      </ul>
    </div>
  );
}
