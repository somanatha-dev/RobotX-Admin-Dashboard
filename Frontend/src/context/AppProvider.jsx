import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

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
import { socket } from '../lib/socket.js';

export default function AppProvider({ children }) {
  const rrNavigate = useNavigate();
  const [isAuthResolved, setIsAuthResolved] = useState(false);

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const notificationsRef = useRef(null);
  const bellButtonRef = useRef(null);

  const [session, setSession] = useState(() => ({ isAuthenticated: false, identity: '', user: null }));

  const [preferences, setPreferences] = useState(() => ({ ...DEFAULT_PREFERENCES }));

  // Legacy cleanup: session is cookie-based now; remove any old persisted client session.
  useEffect(() => {
    try {
      window.localStorage.removeItem('robotx_session');
    } catch {
      // ignore
    }
  }, []);

  const preferencesRef = useRef(preferences);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  const [robots, setRobots] = useState([]);
  const robotsRef = useRef([]);
  useEffect(() => { robotsRef.current = robots; }, [robots]);

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

  const updatePreferences = useCallback(
    (patch) => {
      setPreferences((prev) => {
        const next = { ...prev, ...(patch || {}) };
        const userId = session?.user?.id;
        const email = session?.user?.email || session?.identity || '';
        saveUserPreferences({ userId, email }, next);
        return next;
      });
    },
    [session]
  );

  const navigate = useCallback(
    (to) => {
      rrNavigate(to);
      setIsNotificationsOpen(false);
    },
    [rrNavigate]
  );

  // Guard: prevents concurrent refreshDbState() calls from racing each other.
  // Multiple actions (login, commission, cancel) can fire near-simultaneously;
  // without this, two parallel Promise.all fetches could set stale state.
  const refreshingRef = useRef(false);
  const refreshDbState = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const [robotsNext, tasksNext] = await Promise.all([
        robotsApi.getRobotsState(),
        tasksApi.listTasks(),
      ]);
      setRobots(Array.isArray(robotsNext) ? robotsNext : []);
      setTasks(Array.isArray(tasksNext) ? tasksNext : []);
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  const login = useCallback(
    async (email, password, options = {}) => {
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

      setPreferences(loadUserPreferences({ userId: user?.id, email: user?.email || identity }));
      addEvent(`Signed in as ${identity}`, 'info');
      setIsSidebarOpen(true);

      const shouldNavigate = options?.navigate !== false;
      if (shouldNavigate) navigate('/');

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

        setPreferences(loadUserPreferences({ userId: user?.id, email: user?.email || identity }));
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
      async () => {
        setSystemOnline(false);
        addEvent('EMERGENCY STOP EXECUTED BY COMMANDER', 'critical');

        // Send STOP command to every online robot via the backend.
        const targets = robotsRef.current.filter((r) => r.isOnline);
        await Promise.allSettled(
          targets.map((r) => robotsApi.sendCommand(r.robotId, 'STOP').catch(() => {}))
        );

        setRobots((prev) => prev.map((r) => ({ ...r, status: 'PAUSED', speed: 0 })));
      },
      true
    );
  }, [addEvent, requestAuth]);

  const commission = useCallback(
    (robotData) => {
      requestAuth(`COMMISSION NEW UNIT: ${robotData.id}`, async () => {
        const zoneName = String(robotData.zone || '').trim();
        const robotId = String(robotData.id || '').trim();
        const robotName = String(robotData.name || '').trim() || null;
        if (!zoneName || !robotId) return;

        const lat = robotData?.lat ?? robotData?.zoneLat ?? null;
        const lon = robotData?.lon ?? robotData?.zoneLon ?? null;

        // Create/reuse a Location row for this address.
        const location = await locationsApi.createLocation({
          name: zoneName,
          type: 'AREA',
          lat,
          lon,
        });

        await robotsApi.commissionRobot({
          robotId,
          name: robotName,
          locationId: location.id,
          lat,
          lon,
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

  // ── Live socket subscriptions ─────────────────────────────────────────────
  // Keep global robots/tasks state in sync with backend events so every page
  // (Dashboard, Robots, Tasks) reflects live data without a full refresh.
  useEffect(() => {
    // Single-robot telemetry update — keep battery/status/speed/position live.
    const onRobotUpdate = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (!robotId) return;
      setRobots((prev) =>
        prev.map((r) => {
          if (String(r.robotId || '').trim() !== robotId) return r;
          return {
            ...r,
            ...(typeof data.lat === 'number' ? { lat: data.lat } : {}),
            ...(typeof data.lon === 'number' ? { lon: data.lon } : {}),
            ...(typeof data.battery === 'number' ? { battery: data.battery } : {}),
            ...(typeof data.speed === 'number' ? { speed: data.speed } : {}),
            ...(typeof data.status === 'string' ? { status: data.status } : {}),
            ...(typeof data.isOnline === 'boolean' ? { isOnline: data.isOnline } : {}),
          };
        })
      );
    };

    // Robot fault / status change pushed by ROBOT_FAULT handler.
    const onRobotUpdated = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (!robotId) return;
      setRobots((prev) =>
        prev.map((r) => {
          if (String(r.robotId || '').trim() !== robotId) return r;
          return {
            ...r,
            ...(typeof data.status === 'string' ? { status: data.status } : {}),
          };
        })
      );
      if (data?.fault || data?.healthStatus === 'FAULT') {
        addEvent(`Fault on ${robotId}: ${data?.fault?.message || 'hardware fault'}`, 'critical');
      }
    };

    // Task status change (COMPLETED, REROUTED, CANCELLED, FAILED).
    const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);
    const onTaskUpdated = (data) => {
      const taskId = String(data?.taskId || '').trim();
      if (!taskId) return;
      if (data?.status === 'COMPLETED') {
        addEvent(`Task ${taskId} completed`, 'info');
      } else if (data?.status === 'CANCELLED') {
        addEvent(`Task ${taskId} cancelled`, 'warning');
      } else if (data?.status === 'FAILED') {
        addEvent(`Task ${taskId} failed`, 'critical');
      }
      setTasks((prev) =>
        prev.map((t) => {
          if (String(t.taskId || '').trim() !== taskId) return t;
          return {
            ...t,
            ...(typeof data.status === 'string' ? { status: data.status } : {}),
          };
        })
      );
      // Release robot from task on any terminal status so the UI never shows stale task.
      if (TERMINAL_STATUSES.has(data?.status) && data?.robotId) {
        const rid = String(data.robotId).trim();
        setRobots((prev) =>
          prev.map((r) => {
            if (String(r.robotId || '').trim() !== rid) return r;
            return { ...r, status: 'IDLE', currentTaskId: null, currentTask: null, speed: 0 };
          })
        );
      }
    };

    // Obstacle detected — open the decision modal.
    const onAlertCreated = (data) => {
      const reporterId = String(data?.reportingRobotId || '').trim();
      const severity = String(data?.severity || 'MEDIUM');
      const zone = String(data?.zoneName || data?.zoneId || '');
      const lat = typeof data?.lat === 'number' ? data.lat.toFixed(4) : '?';
      const lon = typeof data?.lon === 'number' ? data.lon.toFixed(4) : '?';

      // Look up the robot's active task ID from the current robots snapshot.
      const reporter = reporterId
        ? robotsRef.current.find((r) => String(r.robotId || '').trim() === reporterId)
        : null;
      const activeTaskId = reporter?.currentTask?.taskId || '';

      addEvent(
        `Obstacle detected${reporterId ? ` by ${reporterId}` : ''} — ${severity}${zone ? ` in ${zone}` : ''}`,
        'critical'
      );

      setDecisionRequest((prev) => {
        // Don't overwrite an active decision already being shown.
        if (prev) return prev;
        return {
          robotId: reporterId || 'UNKNOWN',
          taskId: activeTaskId || String(data?.obstacleId || ''),
          issue: `${severity} obstacle at (${lat}, ${lon})${zone ? ` in ${zone}` : ''}. Backend is auto-rerouting.`,
          countdown: 60,
        };
      });
    };

    // Reroute notification — route overlays handled by useRobotStream.
    const onRerouteAlert = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (robotId) {
        addEvent(`Robot ${robotId} rerouted around obstacle`, 'warning');
      }
    };

    // Subscribe to the single canonical telemetry event.
    // "robot_update" and "ROBOT_UPDATE" were legacy aliases removed from the
    // backend; subscribing to all three was firing the same handler 3× per tick.
    socket.on('robot:update', onRobotUpdate);
    socket.on('ROBOT_UPDATED', onRobotUpdated);
    socket.on('TASK_UPDATED', onTaskUpdated);
    socket.on('ALERT_CREATED', onAlertCreated);
    socket.on('REROUTE_ALERT', onRerouteAlert);

    return () => {
      socket.off('robot:update', onRobotUpdate);
      socket.off('ROBOT_UPDATED', onRobotUpdated);
      socket.off('TASK_UPDATED', onTaskUpdated);
      socket.off('ALERT_CREATED', onAlertCreated);
      socket.off('REROUTE_ALERT', onRerouteAlert);
    };
  }, [addEvent, setDecisionRequest]);
  // ─────────────────────────────────────────────────────────────────────────

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
