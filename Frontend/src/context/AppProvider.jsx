import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { loadSession, saveSession } from '../lib/storage/sessionStorage.js';
import {
  DEFAULT_PREFERENCES,
  loadUserPreferences,
  saveUserPreferences,
} from '../lib/storage/userPreferencesStorage.js';

import { AppActionsContext, AppStateContext } from './appContext.js';

import useDecisionCountdown from '../hooks/useDecisionCountdown.js';
import useNotificationsDismiss from '../hooks/useNotificationsDismiss.js';

import * as authApi from '../lib/api/auth.js';
import * as robotsApi from '../lib/api/robots.js';
import * as tasksApi from '../lib/api/tasks.js';
import * as locationsApi from '../lib/api/locations.js';

export default function AppProvider({ children }) {
  const rrNavigate = useNavigate();
  const [isAuthResolved, setIsAuthResolved] = useState(false);

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const notificationsRef = useRef(null);
  const bellButtonRef = useRef(null);

  const [session, setSession] = useState(() => loadSession());

  const [preferences, setPreferences] = useState(() => {
    const identityEmail = String(loadSession()?.user?.email || loadSession()?.identity || '').trim();
    return loadUserPreferences(identityEmail);
  });

  const preferencesRef = useRef(preferences);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  const [robots, setRobots] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [events, setEvents] = useState([
    { id: 1, msg: 'System initialized successfully', time: 'Just now', type: 'info' },
  ]);

  const [systemOnline, setSystemOnline] = useState(true);
  const [decisionRequest, setDecisionRequest] = useState(null);

  const [authRequest, setAuthRequest] = useState(null); // { intent, action, isDestructive }
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  const addEvent = useCallback((msg, type) => {
    if (!preferencesRef.current.auditLogEnabled) return;
    setEvents((prev) => [{ id: Date.now(), msg, time: 'Just now', type }, ...prev].slice(0, 6));
  }, []);

  const updatePreferences = useCallback((patch) => {
    setPreferences((prev) => {
      const next = { ...prev, ...(patch || {}) };
      const email = String(session?.user?.email || session?.identity || '').trim();
      saveUserPreferences(email, next);
      return next;
    });
  }, [session]);

  const navigate = useCallback(
    (to) => {
      rrNavigate(to);
      setIsNotificationsOpen(false);
    },
    [rrNavigate]
  );

  const refreshDbState = useCallback(async () => {
    const [robotsNext, tasksNext] = await Promise.all([
      robotsApi.getRobotsState(),
      tasksApi.listTasks(),
    ]);
    setRobots(Array.isArray(robotsNext) ? robotsNext : []);
    setTasks(Array.isArray(tasksNext) ? tasksNext : []);
  }, []);

  const login = useCallback(
    async (email, password) => {
      const cleanEmail = String(email || '').trim();
      const cleanPassword = String(password || '');

      if (!cleanEmail || !cleanPassword) {
        const err = new Error('Email and password required');
        err.status = 400;
        throw err;
      }

      const data = await authApi.login({ email: cleanEmail, password: cleanPassword });
      const user = data?.user || null;
      const identity = user?.email || cleanEmail;

      const next = { isAuthenticated: true, identity, user };
      setSession(next);
      saveSession(next);

      setPreferences(loadUserPreferences(identity));
      addEvent(`Signed in as ${identity}`, 'info');
      setIsSidebarOpen(true);
      navigate('/');

      await refreshDbState();

      return data;
    },
    [addEvent, navigate, refreshDbState]
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore
    }

    const next = { isAuthenticated: false, identity: '', user: null };
    setSession(next);
    saveSession(next);
    setPreferences({ ...DEFAULT_PREFERENCES });
    setIsSidebarOpen(false);
    setIsNotificationsOpen(false);
    navigate('/login');
  }, [navigate]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const data = await authApi.me();
        if (!active) return;

        const user = data?.user || null;
        const identity = user?.email || '';
        const next = { isAuthenticated: true, identity, user };
        setSession(next);
        saveSession(next);

        setPreferences(loadUserPreferences(identity));
        setIsAuthResolved(true);

        try {
          await refreshDbState();
        } catch {
          // If robots/tasks APIs are unavailable, keep empty state.
        }
      } catch {
        if (!active) return;

        const next = { isAuthenticated: false, identity: '', user: null };
        setSession(next);
        saveSession(next);
        setPreferences({ ...DEFAULT_PREFERENCES });
        setIsAuthResolved(true);
        navigate('/login');
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const requestAuth = useCallback((intent, action, isDestructive = false) => {
    setAuthRequest({ intent, action, isDestructive });
  }, []);

  const stopAll = useCallback(() => {
    requestAuth(
      'EXECUTE GLOBAL EMERGENCY STOP',
      () => {
        setSystemOnline(false);
        setRobots((prev) => prev.map((r) => ({ ...r, status: 'stopped', speed: 0 })));
        addEvent('EMERGENCY STOP EXECUTED BY COMMANDER', 'critical');
      },
      true
    );
  }, [addEvent, requestAuth]);

  const commission = useCallback(
    (robotData) => {
      requestAuth(`COMMISSION NEW UNIT: ${robotData.id}`, async () => {
        const zoneName = String(robotData.zone || '').trim();
        const robotId = String(robotData.id || '').trim();
        if (!zoneName || !robotId) return;

        // Create/reuse a Location row for this address.
        const location = await locationsApi.createLocation({
          name: zoneName,
          type: 'AREA',
          lat: robotData.zoneLat,
          lon: robotData.zoneLon,
        });

        await robotsApi.commissionRobot({
          robotId,
          locationId: location.id,
          lat: robotData.zoneLat,
          lon: robotData.zoneLon,
        });

        await refreshDbState();
        addEvent(`Unit ${robotId} commissioned`, 'info');
        navigate('/robots');
      });
    },
    [addEvent, navigate, refreshDbState, requestAuth]
  );

  const retire = useCallback(
    (id) => {
      requestAuth(
        `DECOMMISSION UNIT: ${id}`,
        async () => {
          await robotsApi.deleteRobot(id);
          await refreshDbState();
          addEvent(`Unit ${id} decommissioned`, 'warning');
          navigate('/robots');
        },
        true
      );
    },
    [addEvent, navigate, refreshDbState, requestAuth]
  );

  const createTask = useCallback(
    (taskDraft) => {
      setIsCreatingTask(false);
      const robotId = String(taskDraft?.robotId || '').trim();
      const pickup = String(taskDraft?.pickup || '').trim();
      const drop = String(taskDraft?.drop || '').trim();

      requestAuth(`CREATE TASK: ${robotId || 'UNASSIGNED'}`, async () => {
        const created = await tasksApi.assignTask({
          robotId,
          pickup,
          pickupLat: taskDraft?.pickupLat,
          pickupLon: taskDraft?.pickupLon,
          drop,
          dropLat: taskDraft?.dropLat,
          dropLon: taskDraft?.dropLon,
        });

        await refreshDbState();
        addEvent(`Task ${created?.taskId || ''} created`, 'info');
        navigate('/tasks');
      });
    },
    [addEvent, navigate, refreshDbState, requestAuth]
  );

  const cancelTask = useCallback(
    (id) => {
      requestAuth(
        `CANCEL TASK ${id}`,
        async () => {
          await tasksApi.cancelTask(id);
          await refreshDbState();
          addEvent(`Task ${id} cancelled`, 'warning');
        },
        true
      );
    },
    [addEvent, refreshDbState, requestAuth]
  );

  const effectiveRoute = session.isAuthenticated ? '/' : '/login';

  useDecisionCountdown({ decisionRequest, setDecisionRequest, addEvent });

  useNotificationsDismiss({
    isOpen: isNotificationsOpen,
    setIsOpen: setIsNotificationsOpen,
    popupRef: notificationsRef,
    buttonRef: bellButtonRef,
  });

  const stateValue = useMemo(
    () => ({
      effectiveRoute,
      isAuthResolved,
      isSidebarOpen,
      isNotificationsOpen,
      notificationsRef,
      bellButtonRef,
      session,
      preferences,
      robots,
      tasks,
      events,
      systemOnline,
      decisionRequest,
      authRequest,
      isCreatingTask,
    }),
    [
      effectiveRoute,
      isAuthResolved,
      isSidebarOpen,
      isNotificationsOpen,
      session,
      preferences,
      robots,
      tasks,
      events,
      systemOnline,
      decisionRequest,
      authRequest,
      isCreatingTask,
    ]
  );

  const actionsValue = useMemo(
    () => ({
      addEvent,
      navigate,
      login,
      logout,
      updatePreferences,
      requestAuth,
      stopAll,
      commission,
      retire,
      createTask,
      cancelTask,
      setIsSidebarOpen,
      setIsNotificationsOpen,
      setAuthRequest,
      setIsCreatingTask,
      setDecisionRequest,
    }),
    [
      addEvent,
      navigate,
      login,
      logout,
      updatePreferences,
      requestAuth,
      stopAll,
      commission,
      retire,
      createTask,
      cancelTask,
    ]
  );

  return (
    <AppActionsContext.Provider value={actionsValue}>
      <AppStateContext.Provider value={stateValue}>{children}</AppStateContext.Provider>
    </AppActionsContext.Provider>
  );
}
