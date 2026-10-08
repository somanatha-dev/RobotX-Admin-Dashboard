/**
 * Physical-robot enrollment: what the Connect page shows, derived from what is known.
 *
 * ── Where each fact comes from ──────────────────────────────────────────────
 *   · the robot row (app state): whether it exists, is simulated, is online, when last seen;
 *     `isOnline` moves live with the backend's `robot_online` / `robot_offline`;
 *   · `GET /api/robots/:robotId/pairing`: enrolled, a code pending, failed attempts, locked.
 *     Read when the page loads and when the live connection comes back, never on a timer;
 *   · `robot_pairing_rejected`: the robot reached the server and its credential was refused;
 *   · the page's own memory: the code it issued and when it expires. The code exists **only**
 *     there. It is never written to the URL, browser storage or app state, and the backend
 *     never returns it again. A refreshed page therefore knows that a code is pending but
 *     cannot show it, and says so.
 *
 * ── What "connected" does not mean ──────────────────────────────────────────
 * Online means the robot authenticated and is reporting. It does not make the robot
 * available for tasks. Motion and task eligibility are configured separately, and this flow
 * changes neither.
 *
 * Pure: no React, no DOM, no network. The page owns the effects; `src/__architecture__/`
 * exercises this module directly.
 */

/** A pairing code as the backend issues it: six digits, nothing else. */
export const PAIRING_CODE_PATTERN = /^[0-9]{6}$/;

/** Failed attempts before the backend locks pairing for the robot (F32). */
export const PAIRING_LOCKOUT_ATTEMPTS = 5;

/** How long the lockout lasts if nobody lifts it (F32), for the operator-facing sentence. */
export const PAIRING_LOCKOUT_MINUTES = 60;

/** After this long waiting with no sign of the robot, the page lists what to check. */
export const WAITING_HINT_AFTER_MS = 45_000;

/** The one file the Pi agent reads its pairing code from, and the service that reads it. */
export const PI_PAIRING_FILE = '/etc/robotx/pairing.env';
export const PI_AGENT_SERVICE = 'robotx-agent';

export const ENROLLMENT_PHASE = Object.freeze({
  /** The robot list or the pairing status has not arrived yet. */
  LOADING: 'loading',
  /** No such robot (decommissioned, or a typo in the URL). */
  NOT_FOUND: 'not-found',
  /** A simulated robot: it has no Pi and is never paired. */
  SIMULATED: 'simulated',
  /** The status could not be read (backend unreachable). */
  STATUS_UNAVAILABLE: 'status-unavailable',
  /** Online when the page opened: nothing to do, and no code is issued. */
  ALREADY_ONLINE: 'already-online',
  /** Never enrolled, nothing pending: offer to generate a code. */
  READY: 'ready',
  /** Enrolled before, offline now: it reconnects by itself; re-pair only on purpose. */
  ENROLLED_OFFLINE: 'enrolled-offline',
  /** A code was issued earlier (another tab, or before a refresh). It cannot be shown again. */
  CODE_HIDDEN_PENDING: 'code-hidden-pending',
  /** This page issued a code and is waiting for the robot. */
  WAITING: 'waiting',
  /** The code this page issued has expired. */
  EXPIRED: 'expired',
  /** The robot was refused after this page issued its code. */
  REJECTED: 'rejected',
  /** Pairing is locked for this robot (F32). */
  LOCKED: 'locked',
  /** The server no longer holds the code this page issued, and the robot is not online. */
  CODE_NO_LONGER_VALID: 'code-no-longer-valid',
  /** The robot came online while this page was open. */
  CONNECTED: 'connected',
  /** It came online while this page was open, then went offline again. */
  CONNECTION_LOST: 'connection-lost',
});

/**
 * The single command the operator runs on the Pi: write the code where the agent reads it,
 * then restart the agent so it reads it. Built only from a code that is six digits, so nothing
 * else can ever reach the operator's shell through this string.
 *
 * @param {string} code
 * @returns {string}
 * @throws {Error} for anything that is not a six-digit code
 */
export function enrollmentCommand(code) {
  const text = String(code ?? '');
  if (!PAIRING_CODE_PATTERN.test(text)) {
    throw new Error('Not a pairing code: expected exactly six digits.');
  }
  return (
    `printf 'ROBOTX_PAIRING_CODE=%s\\n' ${text} | sudo tee ${PI_PAIRING_FILE} >/dev/null` +
    ` && sudo systemctl restart ${PI_AGENT_SERVICE}`
  );
}

/**
 * Whole seconds left before `expiresAtMs`, never negative.
 *
 * @param {number} expiresAtMs
 * @param {number} nowMs
 * @returns {number}
 */
export function secondsLeft(expiresAtMs, nowMs) {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

/**
 * `m:ss`.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * What the page keeps after `POST /api/robots/commission` answers: the code, and when it
 * expires on this clock. Refuses a response without a six-digit code rather than showing
 * whatever arrived.
 *
 * @param {{ pairingCode?: unknown, expiresIn?: unknown }} response
 * @param {number} nowMs
 * @returns {{ code: string, issuedAtMs: number, expiresAtMs: number }}
 */
export function issuedCodeFrom(response, nowMs) {
  const code = String(response?.pairingCode ?? '');
  if (!PAIRING_CODE_PATTERN.test(code)) {
    throw new Error('The server did not return a pairing code.');
  }
  const expiresIn = Number(response?.expiresIn);
  const lifetimeSec = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300;
  return { code, issuedAtMs: nowMs, expiresAtMs: nowMs + lifetimeSec * 1000 };
}

/**
 * Merge one `robot_pairing_rejected` into the per-robot map the provider keeps.
 *
 * Only the three announced facts are kept. Anything else on the payload is dropped, so even a
 * payload that ever carried more could not put it into app state.
 *
 * @param {Record<string, { failedAttempts: number, locked: boolean, atMs: number }>} prev
 * @param {unknown} data the event payload
 * @param {number} nowMs
 * @returns {Record<string, { failedAttempts: number, locked: boolean, atMs: number }>}
 */
export function applyPairingRejection(prev, data, nowMs) {
  const robotId = typeof data?.robotId === 'string' ? data.robotId.trim() : '';
  if (!robotId) return prev;
  const attempts = Number(data?.failedAttempts);
  return {
    ...(prev || {}),
    [robotId]: {
      failedAttempts: Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 0,
      locked: data?.locked === true,
      atMs: nowMs,
    },
  };
}

/**
 * The page's phase, and the few facts each phase renders.
 *
 * @param {object} input
 * @param {object|null|undefined} input.robot      the row from app state, or undefined
 * @param {boolean} input.robotsLoaded              whether the robot list has arrived
 * @param {object|null} input.status                the last pairing status read, or null
 * @param {number|null} input.statusAtMs            when that status was read
 * @param {boolean} [input.statusFailed]            the last status read failed
 * @param {{ issuedAtMs: number, expiresAtMs: number }|null} input.issued  this page's code, or null
 * @param {{ failedAttempts: number, locked: boolean, atMs: number }|null} input.rejection
 * @param {boolean} input.witnessedConnect          this page saw the robot come online (offline first)
 * @param {number} input.nowMs
 * @returns {{ phase: string, secondsLeft?: number, failedAttempts?: number, showWaitingHint?: boolean }}
 */
export function deriveEnrollmentView({
  robot,
  robotsLoaded,
  status,
  statusAtMs,
  statusFailed = false,
  issued,
  rejection,
  witnessedConnect,
  nowMs,
}) {
  if (!robot) return { phase: robotsLoaded ? ENROLLMENT_PHASE.NOT_FOUND : ENROLLMENT_PHASE.LOADING };
  if (robot.simulated === true) return { phase: ENROLLMENT_PHASE.SIMULATED };

  // Online is the backend's word, pushed live. It outranks everything the page remembers.
  if (robot.isOnline === true) {
    return { phase: issued || witnessedConnect ? ENROLLMENT_PHASE.CONNECTED : ENROLLMENT_PHASE.ALREADY_ONLINE };
  }
  if (witnessedConnect) return { phase: ENROLLMENT_PHASE.CONNECTION_LOST };

  // A refusal is news only if it is newer than what the page already knows: the code this
  // page issued, or else the status it last read (which already counts older refusals). A
  // page that holds no code of its own (opened later, or refreshed) still learns at once that
  // the robot was refused or locked out.
  const knownSinceMs = issued ? issued.issuedAtMs : Number.isFinite(statusAtMs) ? statusAtMs : null;
  const freshRejection = rejection && knownSinceMs !== null && rejection.atMs >= knownSinceMs ? rejection : null;
  const attemptsKnown = Math.max(freshRejection?.failedAttempts ?? 0, status?.failedAttempts ?? 0);

  if (freshRejection?.locked === true || status?.locked === true) {
    return { phase: ENROLLMENT_PHASE.LOCKED, failedAttempts: attemptsKnown };
  }
  if (freshRejection) return { phase: ENROLLMENT_PHASE.REJECTED, failedAttempts: freshRejection.failedAttempts };

  if (issued) {
    const left = secondsLeft(issued.expiresAtMs, nowMs);
    if (left === 0) return { phase: ENROLLMENT_PHASE.EXPIRED, secondsLeft: 0 };
    // Read after the code was issued, and the server holds no code: it was spent, or the
    // server restarted and lost it. Not online, so it was not this robot that spent it.
    if (status && Number.isFinite(statusAtMs) && statusAtMs > issued.issuedAtMs && status.pairingPending === false) {
      return { phase: ENROLLMENT_PHASE.CODE_NO_LONGER_VALID };
    }
    return {
      phase: ENROLLMENT_PHASE.WAITING,
      secondsLeft: left,
      showWaitingHint: nowMs - issued.issuedAtMs >= WAITING_HINT_AFTER_MS,
    };
  }

  if (!status) return { phase: statusFailed ? ENROLLMENT_PHASE.STATUS_UNAVAILABLE : ENROLLMENT_PHASE.LOADING };
  if (status.pairingPending === true) return { phase: ENROLLMENT_PHASE.CODE_HIDDEN_PENDING };
  if (status.enrolled === true) return { phase: ENROLLMENT_PHASE.ENROLLED_OFFLINE };
  return { phase: ENROLLMENT_PHASE.READY, failedAttempts: attemptsKnown };
}

/**
 * The detail page's call to action for a physical unit, from the robot row and (when read)
 * its pairing status. `null` for a simulated unit, or one that is online.
 *
 * @param {object} robot
 * @param {object|null} status
 * @returns {null|{ kind: 'connect'|'repair', label: string }}
 */
export function connectActionFor(robot, status) {
  if (!robot || robot.simulated === true || robot.isOnline === true) return null;
  if (status?.enrolled === true) return { kind: 'repair', label: 'Re-pair Robot' };
  return { kind: 'connect', label: 'Connect Robot' };
}

/**
 * The Connect page's route for a robot.
 *
 * @param {string} robotId
 * @returns {string}
 */
export function connectPathFor(robotId) {
  return `/robots/${encodeURIComponent(String(robotId))}/connect`;
}
