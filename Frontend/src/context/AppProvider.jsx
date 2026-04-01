import React, { useCallback, useMemo, useRef, useState } from 'react';

import { INITIAL_ROBOTS, INITIAL_TASKS } from '../mocks/mockData.js';
import { loadSession, saveSession } from '../lib/storage/sessionStorage.js';

import { AppActionsContext, AppStateContext } from './appContext.js';
import { getEffectiveRoute, getRouteTitle } from '../routes/routes.js';

import useDecisionCountdown from '../hooks/useDecisionCountdown.js';
import useNotificationsDismiss from '../hooks/useNotificationsDismiss.js';
import useRobotSimulator from '../hooks/useRobotSimulator.js';

export default function AppProvider({ children }) {
  const [route, setRoute] = useState('/dashboard');
  const [selectedRobotId, setSelectedRobotId] = useState(null);

  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia?.('(min-width: 1024px)')?.matches ?? true;
  });

  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const notificationsRef = useRef(null);
  const bellButtonRef = useRef(null);

  const [session, setSession] = useState(() => loadSession());

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
    setEvents((prev) => [{ id: Date.now(), msg, time: 'Just now', type }, ...prev].slice(0, 6));
  }, []);

  const navigate = useCallback((newRoute, id = null) => {
    setRoute(newRoute);
    if (id) setSelectedRobotId(id);
    setIsNotificationsOpen(false);
  }, []);

  const login = useCallback(
    (identity) => {
      const next = { isAuthenticated: true, identity };
      setSession(next);
      saveSession(next);
      addEvent(`Signed in as ${identity}`, 'info');
      setRoute('/dashboard');
    },
    [addEvent]
  );

  const logout = useCallback(() => {
    const next = { isAuthenticated: false, identity: '' };
    setSession(next);
    saveSession(next);
    setIsSidebarOpen(false);
    setIsNotificationsOpen(false);
    setRoute('/login');
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

  const effectiveRoute = session.isAuthenticated
    ? getEffectiveRoute({ isAuthenticated: true, route })
    : getEffectiveRoute({ isAuthenticated: false, route });

  const routeTitle = useMemo(() => getRouteTitle(effectiveRoute), [effectiveRoute]);

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
      route,
      effectiveRoute,
      routeTitle,
      selectedRobotId,
      isSidebarOpen,
      isNotificationsOpen,
      notificationsRef,
      bellButtonRef,
      session,
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
      route,
      effectiveRoute,
      routeTitle,
      selectedRobotId,
      isSidebarOpen,
      isNotificationsOpen,
      session,
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
