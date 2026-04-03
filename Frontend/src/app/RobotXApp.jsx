import React from 'react';

import AppProvider from '../context/AppProvider.jsx';
import AppRouter from '../router/AppRouter.jsx';

export default function RobotXApp() {
  return (
    <AppProvider>
      <AppRouter />
    </AppProvider>
  );
}
