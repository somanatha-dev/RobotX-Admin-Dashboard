import React from 'react';

import DashboardPage from '../pages/DashboardPage.jsx';
import MapPage from '../pages/MapPage.jsx';
import ProfilePage from '../pages/ProfilePage.jsx';
import RobotDetailPage from '../pages/RobotDetailPage.jsx';
import RobotsPage from '../pages/RobotsPage.jsx';
import TasksPage from '../pages/TasksPage.jsx';

import { useAppState } from '../context/appContext.js';

export default function AppContent() {
  const { effectiveRoute } = useAppState();

  if (effectiveRoute.startsWith('/robots/')) return <RobotDetailPage />;

  switch (effectiveRoute) {
    case '/dashboard':
      return <DashboardPage />;
    case '/robots':
      return <RobotsPage />;
    case '/map':
      return <MapPage />;
    case '/tasks':
      return <TasksPage />;
    case '/profile':
      return <ProfilePage />;
    default:
      return <DashboardPage />;
  }
}
