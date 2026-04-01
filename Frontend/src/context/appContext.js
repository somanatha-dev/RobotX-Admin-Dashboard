import React, { createContext, useContext } from 'react';

export const AppStateContext = createContext(null);
export const AppActionsContext = createContext(null);

export function useAppState() {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used within <AppProvider />');
  return value;
}

export function useAppActions() {
  const value = useContext(AppActionsContext);
  if (!value) throw new Error('useAppActions must be used within <AppProvider />');
  return value;
}
