import React, { useCallback, useMemo, useRef, useState } from 'react';

import { MapContext } from './mapContext.js';

/**
 * Map/view state.
 *
 * ── Why selection lives here (§19) ────────────────────────────────────────
 * `selectedRobotId` is application state, deliberately. It is NOT stored on a
 * DOM element, a marker instance, or anything else a renderer owns — so
 * replacing the 2D marker renderer with a 3D one later changes nothing about
 * how selection works. A 3D robot raises the same id through the same
 * callback and this same state highlights it.
 *
 * It sits in the map context rather than the global `AppProvider` because it
 * is view state (which robot the operator is inspecting on the map), and
 * because a selection change here must not re-render every consumer of global
 * app state. `followSelected` is the camera's, for the same reason: the camera
 * belongs to the map, and "follow" means "track a world transform", not "track
 * a particular kind of visual object" (§18).
 */
export function MapProvider({ children }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  /** robotId -> { representation, handle, visual } — owned by useRobotStream. */
  const markersRef = useRef(new Map());

  const [selectedRobotId, setSelectedRobotId] = useState(null);
  const [hoveredRobotId, setHoveredRobotId] = useState(null);
  const [followSelected, setFollowSelected] = useState(false);

  const selectRobot = useCallback((robotId) => {
    const id = robotId ? String(robotId) : null;
    setSelectedRobotId((prev) => (prev === id ? null : id));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedRobotId(null);
    setFollowSelected(false);
  }, []);

  const value = useMemo(
    () => ({
      mapContainerRef,
      mapRef,
      markersRef,
      selectedRobotId,
      hoveredRobotId,
      followSelected,
      selectRobot,
      setSelectedRobotId,
      setHoveredRobotId,
      setFollowSelected,
      clearSelection,
    }),
    [selectedRobotId, hoveredRobotId, followSelected, selectRobot, clearSelection]
  );

  return <MapContext.Provider value={value}>{children}</MapContext.Provider>;
}
