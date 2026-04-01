import React from 'react';

import AppProvider from '../context/AppProvider.jsx';
import AppShell from './AppShell.jsx';

export default function RobotXApp() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
