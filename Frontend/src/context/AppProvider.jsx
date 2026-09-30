import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  DEFAULT_PREFERENCES,
  loadUserPreferences,
  saveUserPreferences,
} from '@/lib/storage/userPreferencesStorage.js';

import { AppActionsContext, AppStateContext } from './appContext.js';

import useDecisionCountdown from '@/hooks/useDecisionCountdown.js';
import useNotificationsDismiss from '@/hooks/useNotificationsDismiss.js';

import * as authApi from '@/lib/api/auth.js';
import * as robotsApi from '@/lib/api/robots.js';
import * as simulatorApi from '@/lib/api/simulator.js';
import * as tasksApi from '@/lib/api/tasks.js';
import { buildAssignTaskRequest } from '@/lib/taskRequest.js';
import * as locationsApi from '@/lib/api/locations.js';
import {
  socket,
  DASHBOARD_EVENTS,
  ENGINE_NOT_LIVE,
  SOCKET_UNAUTHORIZED,
  connectDashboardSocket,
  disconnectDashboardSocket,
} from '@/lib/socket.js';
import { ENGINE_CANCELLATION_REASON, isEngineCancellationRefusal } from '@/lib/taskCancellation.js';
import { STOP_ALL_WARNING, summariseStopAll } from '@/lib/robotCommands.js';
import { reopensAssignment } from '@/features/tasks/taskLifecycle.js';

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

  // The simulator's runtime snapshot, or `null` when it could not be read. Held beside
  // the robot list rather than derived from it, because the two answer different
  // questions: a robot row says a unit *is* simulated, and this says whether anything is
  // currently running it. `null` is rendered as "status unknown", never as "not running".
  const [simulatorStatus, setSimulatorStatus] = useState(null);

  const [tasks, setTasks] = useState([]);
  // Persistent cache of task route paths — survives re-renders and page navigation.
  // Populated from TASK_ASSIGNED socket events. Read by the map's useRobotStream.
  const taskPathCacheRef = useRef(new Map());
  // The same routes as render state, for components that display them (the Tasks page's
  // planned-route distance). A ref cannot drive a render; this can. The map keeps reading
  // the ref, unchanged.
  const [taskRoutes, setTaskRoutes] = useState({});
  // Bumped when a robot refuses or defers an offer (see `reopensAssignment`): PENDING task
  // cards re-read their explanation at once instead of on the next 10 s poll.
  const [assignmentSignal, setAssignmentSignal] = useState(0);
  const [events, setEvents] = useState([
    { id: 1, msg: 'System initialized successfully', time: 'Just now', type: 'info' },
  ]);

  const [decisionRequest, setDecisionRequest] = useState(null);

  const [authRequest, setAuthRequest] = useState(null); // { intent, action, isDestructive, warning }
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  // An outcome the operator must see even with the audit log switched off — for example
  // the backend refusing a cancel, or how many units a fleet-wide STOP actually reached.
  // `{ kind: 'warning' | 'info', title, message }`, rendered by the layout until dismissed.
  const [notice, setNotice] = useState(null);
  const showNotice = useCallback((next) => setNotice(next || null), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  // Read by socket handlers, which are registered once and must see the current session.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Set below to `expireSession`, which is defined after `refreshDbState` but is what
  // `refreshDbState` calls when the backend answers 401.
  const sessionExpiredRef = useRef(null);

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
  //
  // A call that arrives while one is in flight is not dropped: it queues exactly one more
  // pass. The socket's `connect` handler relies on that — its refresh is what recovers the
  // events missed while disconnected, and a refresh that had started *before* the socket
  // connected cannot have seen them.
  const refreshingRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshDbState = useCallback(async () => {
    if (refreshingRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshingRef.current = true;
    try {
      do {
        refreshQueuedRef.current = false;
        const [robotsNext, tasksNext, simulatorNext] = await Promise.all([
          robotsApi.getRobotsState(),
          tasksApi.listTasks(),
          // Already failure-tolerant: it resolves to `null` rather than rejecting, so a
          // simulator that is unreachable cannot take the robot and task lists down with
          // it — and `null` is rendered honestly as "status unknown".
          simulatorApi.getSimulatorStatus(),
        ]);
        setRobots(Array.isArray(robotsNext) ? robotsNext : []);
        setTasks(Array.isArray(tasksNext) ? tasksNext : []);
        setSimulatorStatus(simulatorNext || null);
      } while (refreshQueuedRef.current);
    } catch (err) {
      // The session ended under us (expired or revoked cookie). Sign out locally, so the
      // page stops showing a fleet it is no longer allowed to read.
      if (err?.status === 401) sessionExpiredRef.current?.();
      throw err;
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  // Shared by both login methods so a Google sign-in lands in the exact same
  // session shape as a password login — the backend already resolved it to
  // the one account tied to this email, this just reflects that client-side.
  const applyLoggedInSession = useCallback(
    async (user, fallbackIdentity, options = {}) => {
      const identity = user?.email || fallbackIdentity;

      const next = { isAuthenticated: true, identity, user };
      setSession(next);

      setPreferences(loadUserPreferences({ userId: user?.id, email: user?.email || identity }));
      addEvent(`Signed in as ${identity}`, 'info');
      setIsSidebarOpen(true);

      const shouldNavigate = options?.navigate !== false;
      if (shouldNavigate) navigate('/');

      // The sign-in already succeeded by this point — the session above is real.
      // A failure loading robots/tasks is a dashboard problem, not an authentication
      // one, so it must not propagate: callers (LoginPage) treat a rejection here as
      // bad credentials and hold the user on the login screen, which locks them out
      // of a system they are in fact authenticated to. Same guard the session-restore
      // path already applies below.
      try {
        await refreshDbState();
      } catch {
        addEvent('Signed in, but live robot/task data could not be loaded', 'warning');
      }
    },
    [addEvent, navigate, refreshDbState]
  );

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
      await applyLoggedInSession(data?.user || null, cleanEmail, options);

      return data;
    },
    [applyLoggedInSession]
  );

  const loginWithGoogle = useCallback(
    async (credential, options = {}) => {
      const cleanCredential = String(credential || '');

      if (!cleanCredential) {
        const err = new Error('Google credential required');
        err.status = 400;
        throw err;
      }

      const data = await authApi.loginWithGoogle(cleanCredential);
      await applyLoggedInSession(data?.user || null, '', options);

      return data;
    },
    [applyLoggedInSession]
  );

  // Everything this page holds about the fleet and the session, dropped at once. Shared by
  // an explicit logout and by a session the backend no longer accepts, so the two cannot
  // leave different things behind.
  const clearSessionState = useCallback(() => {
    // First, so not one more fleet frame reaches a page that is no longer signed in. The
    // backend's socket session outlives the cookie; only the client closing it ends it.
    disconnectDashboardSocket();

    setSession({ isAuthenticated: false, identity: '', user: null });
    setPreferences({ ...DEFAULT_PREFERENCES });
    setRobots([]);
    setTasks([]);
    setSimulatorStatus(null);
    setEvents([]);
    taskPathCacheRef.current.clear();
    setTaskRoutes({});
    setDecisionRequest(null);
    setAuthRequest(null);
    setIsCreatingTask(false);
    setNotice(null);
    setIsSidebarOpen(false);
    setIsNotificationsOpen(false);
  }, []);

  const logout = useCallback(async () => {
    // Close the socket before the request, not after it: the logout call can be slow or
    // fail, and neither is a reason to keep receiving telemetry.
    disconnectDashboardSocket();
    try {
      await authApi.logout();
    } catch {
      // ignore — the local session is ended either way
    }

    clearSessionState();
    navigate('/login');
  }, [clearSessionState, navigate]);

  // The backend answered 401 to a signed-in page: the cookie expired or was revoked.
  const expireSession = useCallback(() => {
    if (!sessionRef.current?.isAuthenticated) return;
    clearSessionState();
    navigate('/login');
  }, [clearSessionState, navigate]);

  useEffect(() => {
    sessionExpiredRef.current = expireSession;
  }, [expireSession]);

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

        // No session: the socket stays closed (it never opens while logged out).
        disconnectDashboardSocket();
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
  }, [navigate, refreshDbState]);

  // `options.warning` is shown in the authorisation dialog above the confirmation, for acts
  // whose consequence the intent label alone does not state (one-way commands).
  const requestAuth = useCallback((intent, action, isDestructive = false, options = {}) => {
    setAuthRequest({ intent, action, isDestructive, warning: options?.warning || null });
  }, []);

  const stopAll = useCallback(() => {
    requestAuth(
      'EXECUTE GLOBAL EMERGENCY STOP',
      async () => {
        // Send STOP to every online robot via the backend, and report only what the
        // backend answered. No robot's status is written here: PAUSED arrives from the
        // backend (telemetry and the refetch below), for exactly the units it applies to.
        const targets = robotsRef.current.filter((r) => r.isOnline);
        const results = await Promise.allSettled(
          targets.map((r) => robotsApi.sendCommand(r.robotId, 'STOP'))
        );
        const summary = summariseStopAll(results);

        addEvent(
          `EMERGENCY STOP sent to ${summary.accepted}/${summary.total} online unit(s)` +
            (summary.failed ? ` — ${summary.failed} refused` : ''),
          'critical'
        );
        showNotice({
          kind: summary.failed ? 'warning' : 'info',
          title: 'Emergency stop sent',
          message:
            `STOP accepted for ${summary.accepted} of ${summary.total} online unit(s)` +
            `${summary.failed ? `; ${summary.failed} request(s) failed` : ''}. ` +
            'Stopped units are PAUSED and cannot be resumed from the dashboard in V1.',
        });

        try {
          await refreshDbState();
        } catch {
          // The stop was sent; a failed refetch is not a failed stop. Telemetry still updates the list.
        }
      },
      true,
      { warning: STOP_ALL_WARNING }
    );
  }, [addEvent, refreshDbState, requestAuth, showNotice]);

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
          // The chassis the form collected. It used to be gathered and then dropped here,
          // so every unit reached the backend with no type at all — and the backend, having
          // never been told, could not key the unit's `AgentClass` and its model rows.
          chassisType: robotData?.chassisType ?? robotData?.type ?? null,
          // The six specification values plus the declared initial state of charge. Sent as
          // one object so the server validates them as a set — a normal speed above the
          // maximum is only wrong in combination.
          specification: robotData?.specification ?? null,
        });

        await refreshDbState();
        addEvent(`Unit ${robotId} commissioned`, 'info');
        navigate('/robots');
      });
    },
    [addEvent, navigate, refreshDbState, requestAuth]
  );

  /**
   * Create exactly ONE simulated robot, recorded against the signed-in operator.
   *
   * ── Why this is a separate action from `commission` ─────────────────────
   * Because they are separate product flows with separate backends. `commission` records
   * hardware somebody bought and installed: the operator names it and it later proves who
   * it is by pairing. This provisions a test agent the server names, that no hardware will
   * ever claim, and that only a SUPER_ADMIN may ask for. The two never share a form and
   * never share an endpoint — expressing the second as a checkbox on the first is exactly
   * what let simulated units be created with no record of who made them and no role check.
   *
   * ── One call, one robot, as many times as you like ──────────────────────
   * There is no count and no loop here, and there is no per-operator limit either. A
   * SUPER_ADMIN builds SIM-001, SIM-002, SIM-003 by calling this three times. An earlier
   * version of this comment described a one-simulated-robot-per-operator rule enforced by
   * a partial unique index; that rule was a misreading of the requirement and the index
   * has been dropped.
   *
   * ── Why it is not routed through `requestAuth` ──────────────────────────
   * The step-up challenge guards acts that change what the physical fleet *is* or *is
   * doing* — commissioning, decommissioning, task creation, the global stop. Creating a
   * simulated agent is not one of those. What the backend added instead is a server-side
   * SUPER_ADMIN check on the route itself (`requireElevatedRole()` in
   * `simulator.routes.js`), which is authorisation rather than re-authentication and does
   * not belong in front of a form.
   *
   * ── Authorisation is the server's, and stays the server's ───────────────
   * Nothing here checks a role. A caller who is not SUPER_ADMIN receives the server's 403,
   * and it reaches the page as an ordinary rejection. A client-side guard would be a
   * second copy of a rule that lives on the server, and it would be the copy that is wrong.
   *
   * @param {object} draft what the form collected
   * @returns {Promise<object>} the created robot, projected (no creator id)
   */
  const createSimulatedRobot = useCallback(
    async (draft) => {
      const zoneName = String(draft?.zone || '').trim();
      if (!zoneName) {
        const err = new Error('An operating zone is required.');
        err.status = 400;
        throw err;
      }

      const lat = draft?.lat ?? draft?.zoneLat ?? null;
      const lon = draft?.lon ?? draft?.zoneLon ?? null;

      // Create/reuse a Location row for this address — the same step physical
      // commissioning takes, through the same API.
      const location = await locationsApi.createLocation({
        name: zoneName,
        type: 'AREA',
        lat,
        lon,
      });

      // No robotId, no count, no simulated flag, no owner. The server decides all four.
      const result = await simulatorApi.createSimulatedRobot({
        name: String(draft?.name || '').trim() || null,
        locationId: location.id,
        lat,
        lon,
        chassisType: draft?.chassisType ?? null,
        specification: draft?.specification ?? null,
      });

      await refreshDbState();
      addEvent(
        `Simulated unit ${result?.robot?.robotId || ''} created (${result?.status || 'unknown state'})`,
        'info',
      );
      return result;
    },
    [addEvent, refreshDbState],
  );

  /**
   * Edit a commissioned unit's configuration.
   *
   * Not routed through `requestAuth`: the step-up challenge guards commissioning,
   * decommissioning, task creation and the global stop — acts that change what the fleet
   * *is* or *is doing*. Correcting a payload capacity is an ordinary administrative edit,
   * and putting a PIN prompt in front of every keystroke's worth of it would train
   * operators to type the PIN without reading what it is authorising.
   *
   * Resolves to the updated unit so the caller can close its form only on success; a
   * rejection carries the server's own sentence, which is the one that names the field.
   */
  const updateRobotSpecification = useCallback(
    async (robotId, patch) => {
      const id = String(robotId || '').trim();
      if (!id) return null;

      const robot = await robotsApi.updateRobot(id, patch);

      setRobots((prev) =>
        prev.map((r) => (String(r.robotId || '').trim() === id ? { ...r, ...robot } : r)),
      );
      addEvent(`Unit ${id} configuration updated`, 'info');
      return robot;
    },
    [addEvent]
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

      requestAuth(`CREATE TASK: ${robotId || 'UNASSIGNED'}`, async () => {
        // The request body, including the campus's operating region (`regionId`), which
        // the backend requires. Built by one plain function so the architecture tests
        // exercise exactly what is sent; it throws for a campus with no region.
        const created = await tasksApi.assignTask(buildAssignTaskRequest(taskDraft));

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
          try {
            await tasksApi.cancelTask(id);
          } catch (err) {
            // The backend's answer for an engine-managed task (P1.4): 409, nothing changed.
            // It is not an authorisation failure — the PIN was accepted — so the dialog
            // closes (this action resolves) and the refusal is shown as what it is. No
            // "cancelled" event, no local status change.
            if (isEngineCancellationRefusal(err)) {
              showNotice({
                kind: 'warning',
                title: `Task ${id} was not cancelled`,
                message: err.message || ENGINE_CANCELLATION_REASON,
              });
              try {
                await refreshDbState();
              } catch {
                // the notice already says nothing changed
              }
              return;
            }
            throw err;
          }
          await refreshDbState();
          addEvent(`Task ${id} cancelled`, 'warning');
        },
        true
      );
    },
    [addEvent, refreshDbState, requestAuth, showNotice]
  );

  const effectiveRoute = session.isAuthenticated ? '/' : '/login';

  useDecisionCountdown({ decisionRequest, setDecisionRequest, addEvent });

  // ── The dashboard socket's lifetime is the session's ──────────────────────
  //
  // Connected after a successful login or session restore (both set
  // `session.isAuthenticated`, and the auth cookie already exists by then), closed when the
  // session ends. It is never open while logged out, so the backend's refusal of an
  // unauthenticated dashboard socket is never provoked by this page, and a refused socket
  // is never left to sit dead behind a signed-in dashboard.
  useEffect(() => {
    if (session.isAuthenticated) connectDashboardSocket();
    else disconnectDashboardSocket();
  }, [session.isAuthenticated]);

  // Set once `UNAUTHORIZED` has been answered with a reconnect; cleared by the next
  // successful connection. It is what makes a second refusal final instead of a loop.
  const unauthorizedRetriedRef = useRef(false);
  const reconnectAfterServerDisconnectRef = useRef(false);

  useEffect(() => {
    // Every (re)connection — first connect after login, or socket.io recovering a dropped
    // transport — reloads robots, tasks and simulator state, so nothing that happened
    // while the socket was down stays missing from the page.
    const onConnect = () => {
      unauthorizedRetriedRef.current = false;
      refreshDbState().catch(() => {
        // a 401 here already signed the page out (see refreshDbState)
      });
    };

    // The backend refused this socket's session and is about to disconnect it itself.
    // socket.io does not retry a server-side disconnect, so this cannot loop by itself;
    // the only reconnect is the single one below, and only while the REST session is valid.
    const onUnauthorized = async () => {
      if (!sessionRef.current?.isAuthenticated) return;
      try {
        await authApi.me();
      } catch (err) {
        if (err?.status === 401) sessionExpiredRef.current?.();
        return;
      }
      if (!sessionRef.current?.isAuthenticated) return;
      if (unauthorizedRetriedRef.current) {
        addEvent('Live updates stopped: the server refused the live connection. Reload the page.', 'warning');
        return;
      }
      unauthorizedRetriedRef.current = true;
      // Still marked active until the server's disconnect arrives; reconnect after it.
      if (socket.active) reconnectAfterServerDisconnectRef.current = true;
      else connectDashboardSocket();
    };

    const onDisconnect = (reason) => {
      if (reason !== 'io server disconnect' || !reconnectAfterServerDisconnectRef.current) return;
      reconnectAfterServerDisconnectRef.current = false;
      if (sessionRef.current?.isAuthenticated) connectDashboardSocket();
    };

    socket.on('connect', onConnect);
    socket.on(SOCKET_UNAUTHORIZED, onUnauthorized);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('connect', onConnect);
      socket.off(SOCKET_UNAUTHORIZED, onUnauthorized);
      socket.off('disconnect', onDisconnect);
    };
  }, [addEvent, refreshDbState]);

  // ── Live socket subscriptions ─────────────────────────────────────────────
  // Keep global robots/tasks state in sync with backend events so every page
  // (Dashboard, Robots, Tasks) reflects live data without a full refresh.
  useEffect(() => {
    // Single-robot telemetry update — keep battery/status/speed/position/distanceTravelled live.
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
            ...(typeof data.distanceTravelled === 'number' ? { distanceTravelled: data.distanceTravelled } : {}),
            ...(typeof data.heading === 'number' ? { heading: data.heading } : {}),
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

    // A unit's configuration changed — from this session's edit form, or another
    // operator's. Merged rather than replaced so the live telemetry fields on the row
    // (battery, position, speed) are not rolled back to whatever the edit response
    // happened to carry.
    const onRobotSpecificationUpdated = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (!robotId || !data?.specification) return;
      setRobots((prev) =>
        prev.map((r) =>
          String(r.robotId || '').trim() === robotId
            ? {
                ...r,
                specification: data.specification,
                ...(typeof data.name === 'string' ? { name: data.name } : {}),
              }
            : r,
        ),
      );
    };

    // New PENDING task created — add to list immediately so spinner shows.
    const onTaskCreated = (data) => {
      const taskId = String(data?.taskId || '').trim();
      if (!taskId) return;
      setTasks((prev) => {
        if (prev.some((t) => String(t.taskId || '').trim() === taskId)) return prev;
        return [{ ...data, status: 'PENDING' }, ...prev];
      });
    };

    // Task status change + optional robot/distance enrichment (ASSIGNED, COMPLETED, etc.).
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
            // Enrich with robot info when DTARO assignment completes (ASSIGNED event).
            ...(data.robot ? { robot: data.robot } : {}),
            ...(typeof data.distanceMeters === 'number' ? { distanceMeters: data.distanceMeters } : {}),
            ...(data.robotId ? { robotId: data.robotId } : {}),
            // Carried by a VERIFYING update (insufficient or unavailable completion
            // evidence); the card shows it as the reason the task is held.
            ...(data.verification && typeof data.verification === 'object' ? { verification: data.verification } : {}),
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

    // `TASK_ASSIGNED` (capitals) — unchanged by the cutover and genuinely means
    // assigned: it is emitted when a route exists to draw, which is after a real
    // decision. Not to be confused with the lower-case `task_assigned`
    // compatibility echo, which this provider does not subscribe to.
    //
    // Cached so the map can draw the lines even if the user navigates to /map
    // after the event fired.
    const onTaskAssigned = (data) => {
      const taskId  = String(data?.taskId  || '').trim();
      const robotId = String(data?.robotId || '').trim();
      if (!taskId) return;
      const pathToPickup = Array.isArray(data?.pathToPickup) ? data.pathToPickup : null;
      const pathToDrop   = Array.isArray(data?.pathToDrop)   ? data.pathToDrop   : null;
      if (!pathToPickup || !pathToDrop) return;
      taskPathCacheRef.current.set(taskId, {
        taskId,
        robotId: robotId || null,
        pickup: data?.pickup ?? null,
        drop:   data?.drop   ?? null,
        pathToPickup,
        pathToDrop,
      });
      setTaskRoutes((prev) => ({ ...prev, [taskId]: { pathToPickup, pathToDrop } }));
    };

    // Reroute notification — route overlays handled by useRobotStream.
    const onRerouteAlert = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (robotId) {
        addEvent(`Robot ${robotId} rerouted around obstacle`, 'warning');
      }
    };

    // ── PHASE 15 — §3.4's intake acknowledgement ────────────────────────────
    //
    // `task_accepted` is the honest event: the task was validated, admitted,
    // deduplicated, routed to a shard and durably queued. **No robot has been
    // chosen yet** — the engine decides in a later round — so the card shows a
    // queue position and a predicted window rather than a spinner that implies an
    // assignment is already under way.
    //
    // The legacy `task_assigned` still fires beside it for unmigrated clients and
    // is deliberately NOT subscribed to here: its payload says PENDING with a null
    // robot, and reading it as an assignment is exactly the conflation §3.4
    // forbids. See `lib/socket.js` for the full contract.
    const onTaskAccepted = (data) => {
      const taskId = String(data?.taskId || '').trim();
      if (!taskId) return;
      setTasks((prev) =>
        prev.map((t) =>
          String(t.taskId || '').trim() === taskId
            ? {
                ...t,
                status: 'PENDING',
                queuePosition: typeof data?.queuePosition === 'number' ? data.queuePosition : null,
                predictedAssignmentWindow: data?.predictedAssignmentWindow ?? null,
                intakeSentence: data?.sentence ?? null,
              }
            : t,
        ),
      );
    };

    // Intake refused the submission. After the cutover the most important refusal
    // is ENGINE_NOT_LIVE: the shard has no decision path, because the legacy
    // dispatcher was removed from the build rather than merely bypassed. Showing
    // it is the difference between an operator who knows to check the rollout and
    // one watching a card that will never move.
    const onTaskError = (data) => {
      const taskId = String(data?.taskId || '').trim();
      const message =
        data?.code === ENGINE_NOT_LIVE
          ? `Task ${taskId || ''} refused — the assignment engine is not live for this shard. No work is queued.`
          : `Task ${taskId || ''} refused — ${data?.error || 'unknown reason'}`;
      addEvent(message.trim(), data?.code === ENGINE_NOT_LIVE ? 'critical' : 'warning');
      if (!taskId) return;
      setTasks((prev) =>
        prev.map((t) =>
          String(t.taskId || '').trim() === taskId
            ? { ...t, status: 'FAILED', intakeSentence: data?.error ?? null, intakeCode: data?.code ?? null }
            : t,
        ),
      );
    };

    // §11.2 — the agent may refuse an offer. Three outcomes, and they are not the
    // same event: an ACCEPT is progress, a REJECT re-plans the Leg, and a DEFER is
    // an agent deliberately holding work. The baseline could express none of them.
    const onOfferResponse = (data) => {
      const robotId = String(data?.agentId || data?.robotId || '').trim();
      const response = String(data?.response || '').trim();
      if (!response) return;
      if (reopensAssignment(data)) setAssignmentSignal((n) => n + 1);
      if (response === 'OFFER_REJECT') {
        addEvent(`Robot ${robotId || 'unknown'} rejected an offer — re-planning`, 'warning');
      } else if (response === 'OFFER_DEFER') {
        addEvent(`Robot ${robotId || 'unknown'} deferred an offer`, 'warning');
      }
    };

    // Subscribe to the single canonical telemetry event.
    // "robot_update" and "ROBOT_UPDATE" were legacy aliases removed from the
    // backend; subscribing to all three was firing the same handler 3× per tick.
    socket.on(DASHBOARD_EVENTS.ROBOT_UPDATE, onRobotUpdate);
    socket.on(DASHBOARD_EVENTS.ROBOT_UPDATED, onRobotUpdated);
    socket.on(DASHBOARD_EVENTS.ROBOT_SPECIFICATION_UPDATED, onRobotSpecificationUpdated);
    socket.on(DASHBOARD_EVENTS.TASK_CREATED, onTaskCreated);
    socket.on(DASHBOARD_EVENTS.TASK_ACCEPTED, onTaskAccepted);
    socket.on(DASHBOARD_EVENTS.TASK_ERROR, onTaskError);
    socket.on(DASHBOARD_EVENTS.OFFER_RESPONSE, onOfferResponse);
    socket.on(DASHBOARD_EVENTS.TASK_UPDATED, onTaskUpdated);
    socket.on(DASHBOARD_EVENTS.TASK_ASSIGNED, onTaskAssigned);
    socket.on(DASHBOARD_EVENTS.ALERT_CREATED, onAlertCreated);
    socket.on(DASHBOARD_EVENTS.REROUTE_ALERT, onRerouteAlert);

    return () => {
      socket.off(DASHBOARD_EVENTS.ROBOT_UPDATE, onRobotUpdate);
      socket.off(DASHBOARD_EVENTS.ROBOT_UPDATED, onRobotUpdated);
      socket.off(DASHBOARD_EVENTS.ROBOT_SPECIFICATION_UPDATED, onRobotSpecificationUpdated);
      socket.off(DASHBOARD_EVENTS.TASK_CREATED, onTaskCreated);
      socket.off(DASHBOARD_EVENTS.TASK_ACCEPTED, onTaskAccepted);
      socket.off(DASHBOARD_EVENTS.TASK_ERROR, onTaskError);
      socket.off(DASHBOARD_EVENTS.OFFER_RESPONSE, onOfferResponse);
      socket.off(DASHBOARD_EVENTS.TASK_UPDATED, onTaskUpdated);
      socket.off(DASHBOARD_EVENTS.TASK_ASSIGNED, onTaskAssigned);
      socket.off(DASHBOARD_EVENTS.ALERT_CREATED, onAlertCreated);
      socket.off(DASHBOARD_EVENTS.REROUTE_ALERT, onRerouteAlert);
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
      simulatorStatus,
      tasks,
      events,
      notice,
      decisionRequest,
      authRequest,
      isCreatingTask,
      taskPathCacheRef,
      taskRoutes,
      assignmentSignal,
    }),
    [
      effectiveRoute,
      isAuthResolved,
      isSidebarOpen,
      isNotificationsOpen,
      session,
      preferences,
      robots,
      simulatorStatus,
      tasks,
      events,
      notice,
      decisionRequest,
      authRequest,
      isCreatingTask,
      taskRoutes,
      assignmentSignal,
      // taskPathCacheRef is a ref — excluded from deps intentionally
      // (its identity is stable; contents change without re-render)
    ]
  );

  const actionsValue = useMemo(
    () => ({
      addEvent,
      navigate,
      login,
      loginWithGoogle,
      logout,
      updatePreferences,
      requestAuth,
      stopAll,
      commission,
      createSimulatedRobot,
      updateRobotSpecification,
      retire,
      createTask,
      cancelTask,
      refreshDbState,
      showNotice,
      dismissNotice,
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
      loginWithGoogle,
      logout,
      updatePreferences,
      requestAuth,
      stopAll,
      commission,
      createSimulatedRobot,
      updateRobotSpecification,
      retire,
      createTask,
      cancelTask,
      refreshDbState,
      showNotice,
      dismissNotice,
    ]
  );

  return (
    <AppActionsContext.Provider value={actionsValue}>
      <AppStateContext.Provider value={stateValue}>{children}</AppStateContext.Provider>
    </AppActionsContext.Provider>
  );
}
