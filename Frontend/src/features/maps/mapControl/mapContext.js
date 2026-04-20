import { createContext, useContext } from 'react';

export const MapContext = createContext(null);

export function useMapContext() {
  const ctx = useContext(MapContext);
  if (!ctx) throw new Error('useMapContext must be used within <MapProvider />');
  return ctx;
}
