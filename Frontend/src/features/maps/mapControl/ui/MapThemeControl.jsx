import React from 'react';

import { MAP_THEME_LABEL, MAP_THEME_ORDER } from '../../theme/mapThemes.js';
import { CAMPUS_CAMERA_MODE_LABEL, CAMPUS_CAMERA_MODE_ORDER } from '../../camera/cameraModes.js';

/**
 * UI LAYER — the map's own view controls: time of day, and camera framing.
 *
 * A compact segmented control rather than a radio list (§16), because it sits
 * over a live operational map where every pixel of chrome is covering
 * something the operator might need to see.
 *
 * Both controls only ever write view state. Neither can move a robot, change a
 * route, or alter anything the map is a visualization OF.
 */
export function MapThemeControl({
  themeId,
  onThemeChange,
  isTransitioning,
  cameraMode,
  onCameraModeChange,
  showCameraModes,
  followDisabled,
  onResetCamera,
}) {
  return (
    <div className="map-view-controls" aria-label="Map view controls">
      <div className="map-segmented" role="radiogroup" aria-label="Map theme">
        {MAP_THEME_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={themeId === id}
            className={`map-segmented__item${themeId === id ? ' is-active' : ''}`}
            onClick={() => onThemeChange?.(id)}
          >
            {MAP_THEME_LABEL[id]}
          </button>
        ))}
        {/* Announced, not drawn — a spinner over an operations map is noise. */}
        <span className="sr-only" role="status" aria-live="polite">
          {isTransitioning ? 'Changing map theme' : ''}
        </span>
      </div>

      {showCameraModes && (
        <div className="map-segmented" role="radiogroup" aria-label="Camera mode">
          {CAMPUS_CAMERA_MODE_ORDER.map((mode) => {
            const disabled = mode === 'FOLLOW' && followDisabled;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={cameraMode === mode}
                disabled={disabled}
                title={disabled ? 'Select a robot to follow it' : undefined}
                className={`map-segmented__item${cameraMode === mode ? ' is-active' : ''}`}
                onClick={() => onCameraModeChange?.(mode)}
              >
                {CAMPUS_CAMERA_MODE_LABEL[mode]}
              </button>
            );
          })}
          <button
            type="button"
            className="map-segmented__item map-segmented__item--action"
            onClick={() => onResetCamera?.()}
            title="Return to the default campus view"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
