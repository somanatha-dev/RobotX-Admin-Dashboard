import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import Layout from './layout.tsx';

import DashboardPage from '../pages/DashboardPage.jsx';
import LoginPage from '../pages/LoginPage.jsx';
import MapPage from '../pages/MapPage.jsx';
import ProfilePage from '../pages/ProfilePage.jsx';
import RobotDetailPage from '../pages/RobotDetailPage.jsx';
import RobotsPage from '../pages/RobotsPage.jsx';
import TasksPage from '../pages/TasksPage.jsx';

import { useAppState } from '../context/appContext.js';

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
