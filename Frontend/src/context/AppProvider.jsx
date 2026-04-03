import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { INITIAL_ROBOTS, INITIAL_TASKS } from '../mocks/mockData.js';
import { loadSession, saveSession } from '../lib/storage/sessionStorage.js';
import {
  DEFAULT_PREFERENCES,
  loadUserPreferences,
  saveUserPreferences,
} from '../lib/storage/userPreferencesStorage.js';

import { AppActionsContext, AppStateContext } from './appContext.js';

import useDecisionCountdown from '../hooks/useDecisionCountdown.js';
import useNotificationsDismiss from '../hooks/useNotificationsDismiss.js';
import useRobotSimulator from '../hooks/useRobotSimulator.js';

import * as authApi from '../lib/api/auth.js';

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

  const [robots, setRobots] = useState(INITIAL_ROBOTS);
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [events, setEvents] = useState([
    { id: 1, msg: 'System initialized successfully', time: 'Just now', type: 'info' },
  ]);

  const [systemOnline, setSystemOnline] = useState(true);
  const [decisionRequest, setDecisionRequest] = useState(null);

  const [authRequest, setAuthRequest] = useState(null); // { intent, action, isDestructive }
  const [isCommissioning, setIsCommissioning] = useState(false);
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

      return data;
    },
    [addEvent, navigate]
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
      requestAuth(`COMMISSION NEW UNIT: ${robotData.id}`, () => {
        setRobots((prev) => [
          {
            ...robotData,
            status: 'idle',
            battery: 100,
            speed: 0,
            task: null,
            location: { x: 50, y: 50 },
            locText: robotData.zone,
            health: { gps: true, telemetry: true, motors: true, connection: true },
            issue: null,
          },
          ...prev,
        ]);
        setIsCommissioning(false);
        addEvent(`Unit ${robotData.id} commissioned and online`, 'info');
      });
    },
    [addEvent, requestAuth]
  );

  const retire = useCallback(
    (id) => {
      requestAuth(
        `DECOMMISSION UNIT: ${id}`,
        () => {
          setRobots((prev) => prev.filter((r) => r.id !== id));
          addEvent(`Unit ${id} permanently decommissioned`, 'warning');
          navigate('/map');
        },
        true
      );
    },
    [addEvent, navigate, requestAuth]
  );

  const createTask = useCallback(
    (taskDraft) => {
      setIsCreatingTask(false);
      requestAuth(`CREATE TASK: ${taskDraft.id}`, () => {
        setTasks((prev) => [taskDraft, ...prev]);
        addEvent(`Task ${taskDraft.id} created`, 'info');
        navigate('/tasks');
      });
    },
    [addEvent, navigate, requestAuth]
  );

  const cancelTask = useCallback(
    (id) => {
      requestAuth(
        `CANCEL TASK ${id}`,
        () => {
          setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'failed' } : t)));
          addEvent(`Task ${id} cancelled`, 'warning');
        },
        true
      );
    },
    [addEvent, requestAuth]
  );

  const effectiveRoute = session.isAuthenticated ? '/' : '/login';

  useRobotSimulator({
    systemOnline,
    decisionRequest,
    robots,
    setRobots,
    setDecisionRequest,
  });

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
      isCommissioning,
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
      isCommissioning,
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
      setIsCommissioning,
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
