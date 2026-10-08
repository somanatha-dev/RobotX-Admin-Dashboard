import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import Layout from './layout.jsx';

import DashboardPage from '@/pages/DashboardPage.jsx';
import LoginPage from '@/pages/LoginPage.jsx';
import MapPage from '@/pages/MapPage.jsx';
import ProfilePage from '@/pages/ProfilePage.jsx';
import CommissionPage from '@/pages/CommissionPage.jsx';
import ConnectRobotPage from '@/pages/ConnectRobotPage.jsx';
import RobotDetailPage from '@/pages/RobotDetailPage.jsx';
import RobotsPage from '@/pages/RobotsPage.jsx';
import SimulatedRobotPage from '@/pages/SimulatedRobotPage.jsx';
import TasksPage from '@/pages/TasksPage.jsx';

import { useAppState } from '@/context/appContext.js';

function RequireAuth({ children }) {
  const { session, isAuthResolved, isAuthUnreachable } = useAppState();

  // FS-03 — the session check could not reach the backend. That is not "signed out", so
  // this is not the login page: the check repeats until the backend answers.
  if (!isAuthResolved && isAuthUnreachable) {
    return (
      <div role="status" data-session-check="unreachable" className="flex h-screen items-center justify-center p-6">
        <div className="max-w-sm rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <div className="font-semibold">Cannot reach the RobotX backend</div>
          <div className="mt-1 text-xs">
            Your session could not be checked, so nothing is shown yet. Retrying automatically;
            you have not been signed out.
          </div>
        </div>
      </div>
    );
  }
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
        {/* Enrollment of a physical unit's Pi: issue a one-time code, wait for the robot. */}
        <Route path="robots/:id/connect" element={<ConnectRobotPage />} />
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
