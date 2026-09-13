import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import Layout from './layout.jsx';

import DashboardPage from '@/pages/DashboardPage.jsx';
import LoginPage from '@/pages/LoginPage.jsx';
import MapPage from '@/pages/MapPage.jsx';
import ProfilePage from '@/pages/ProfilePage.jsx';
import CommissionPage from '@/pages/CommissionPage.jsx';
import RobotDetailPage from '@/pages/RobotDetailPage.jsx';
import RobotsPage from '@/pages/RobotsPage.jsx';
import SimulatedRobotPage from '@/pages/SimulatedRobotPage.jsx';
import TasksPage from '@/pages/TasksPage.jsx';

import { useAppState } from '@/context/appContext.js';

function RequireAuth({ children }) {
  const { session, isAuthResolved } = useAppState();

  if (!isAuthResolved) return null;
  if (!session?.isAuthenticated) return <Navigate to="/login" replace />;

  return children;
}

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="robots" element={<RobotsPage />} />
        <Route path="robots/:id" element={<RobotDetailPage />} />
        <Route path="commission" element={<CommissionPage />} />
        {/* Its own route, not a mode of `commission`. Physical commissioning and
            simulated creation are separate product flows with separate endpoints, and
            sharing a screen is what let one become a checkbox on the other. */}
        <Route path="simulator/new" element={<SimulatedRobotPage />} />
        <Route path="map" element={<MapPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="profile" element={<ProfilePage />} />

        {/* Back-compat */}
        <Route path="dashboard" element={<Navigate to="/" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
