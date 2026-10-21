/**
 * RBAC — what the signed-in account may be offered in the dashboard.
 *
 * These decide what to SHOW, never what is allowed: the backend enforces every rule here
 * (role, campus, commands) and refuses whatever a modified client sends. Mirrors the server's
 * policy so a campus administrator is not offered controls the server will refuse:
 *
 *   SUPER_ADMIN  everything the dashboard has.
 *   ADMIN        its one campus — robots, tasks and STOP / PAUSE. No commissioning, simulator,
 *                account management, configuration, or commands that set a unit moving.
 *
 * The role and campus come from the server's own answer (`/api/auth/me`, the login response),
 * never from anything the browser chose.
 */

export const ROLE = Object.freeze({ SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN' });

/** The commands a campus administrator may send — the two that stop motion and hold the unit. */
const ADMIN_COMMANDS = new Set(['STOP', 'PAUSE']);

export function roleOf(session) {
  return session?.user?.role || null;
}

export function isSuperAdmin(session) {
  return roleOf(session) === ROLE.SUPER_ADMIN;
}

/** The ADMIN's campus `{ id, code, name, regionId }`, or null. */
export function campusOf(session) {
  return session?.user?.campus || null;
}

/** An ADMIN whose campus is missing: the server refuses it everything, so the UI says so. */
export function hasInvalidScope(session) {
  const role = roleOf(session);
  if (role === ROLE.SUPER_ADMIN) return false;
  if (role === ROLE.ADMIN) return !campusOf(session);
  return Boolean(session?.isAuthenticated);
}

export function mayCommand(session, type) {
  if (isSuperAdmin(session)) return true;
  return roleOf(session) === ROLE.ADMIN && Boolean(campusOf(session)) && ADMIN_COMMANDS.has(String(type).toUpperCase());
}

/**
 * Did the account's access change between two server answers (role, or campus)? When it
 * did, everything the page holds was read under the old scope and must be dropped before
 * anything of the new scope is shown.
 */
export function accessChanged(before, after) {
  if (!before || !after) return Boolean(before) !== Boolean(after);
  return before.role !== after.role || (before.campus?.id || null) !== (after.campus?.id || null);
}

/** What a campus administrator is told in place of the simulator's runtime/charging details. */
export const SIMULATOR_RESTRICTED_NOTE =
  'Simulator runtime and charging details are available to super administrators only.';

/** May this account read the SUPER_ADMIN-only simulator report (charging, runtime)? */
export function mayReadSimulator(session) {
  return isSuperAdmin(session);
}

/**
 * The campuses the task form offers: every registered campus for a SUPER_ADMIN; for a campus
 * ADMIN only the registry entry whose id is its `Campus.code`; nothing for anyone else. The
 * backend still pins an ADMIN's submission to its campus's region regardless of this list.
 *
 * @param {object} session
 * @param {Array<{ id: string }>} registry `CAMPUS_REGISTRY`
 */
export function taskCampusesFor(session, registry) {
  const list = Array.isArray(registry) ? registry : [];
  if (isSuperAdmin(session)) return list;
  const campus = campusOf(session);
  if (roleOf(session) !== ROLE.ADMIN || !campus) return [];
  return list.filter((entry) => entry?.id === campus.code);
}

/** The sidebar's account line: role, and for an ADMIN its campus. */
export function accountLabel(session) {
  const role = roleOf(session);
  if (role === ROLE.SUPER_ADMIN) return 'Super Admin';
  if (role === ROLE.ADMIN) {
    const campus = campusOf(session);
    return campus ? `Admin · ${campus.name || campus.code}` : 'Admin · no campus assigned';
  }
  return session?.identity || 'Operator';
}
