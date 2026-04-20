import React, { useMemo, useRef } from 'react';

import { MapContext } from './mapContext.js';

export function MapProvider({ children }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());

  const value = useMemo(
    () => ({
      mapContainerRef,
      mapRef,
      markersRef,
    }),
    []
  );

  return <MapContext.Provider value={value}>{children}</MapContext.Provider>;
}
