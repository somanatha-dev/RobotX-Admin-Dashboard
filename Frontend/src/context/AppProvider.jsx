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
import * as locationsApi from '@/lib/api/locations.js';
import { socket, DASHBOARD_EVENTS, ENGINE_NOT_LIVE } from '@/lib/socket.js';

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
  }, [navigate, refreshDbState]);

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
          // §15.1's payload specification, as declared. Mass **and** its tolerance:
          // feasibility uses the upper bound of the tolerance, so a mass without one is a
          // payload the gate cannot reason about, and the server refuses it rather than
          // inventing a precision nobody stated.
          payload: taskDraft?.payload ?? null,
          // The agent class this task is asking for. It becomes a §2.3 requirement on the
          // Task's RequirementSet and is matched by predicate F21 against the unit's
          // attested capability bundle — the existing eligibility path, not a filter of
          // its own and nothing hard-coded about which unit goes.
          requestedChassisType: taskDraft?.requestedChassisType ?? null,
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
      systemOnline,
      decisionRequest,
      authRequest,
      isCreatingTask,
      taskPathCacheRef,
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
      systemOnline,
      decisionRequest,
      authRequest,
      isCreatingTask,
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
    ]
  );

  return (
    <AppActionsContext.Provider value={actionsValue}>
      <AppStateContext.Provider value={stateValue}>{children}</AppStateContext.Provider>
    </AppActionsContext.Provider>
  );
}
