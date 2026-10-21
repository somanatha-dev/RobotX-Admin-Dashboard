import { requestJson } from './httpClient.js';

// RBAC — campus administrator accounts (`/api/users`, SUPER_ADMIN only on the server).

export async function listUsers() {
  const data = await requestJson('/api/users');
  return Array.isArray(data?.users) ? data.users : [];
}

/** `{ email, password, campusId }` → the new ADMIN. The role is the server's, not an input. */
export async function createAdmin({ email, password, campusId }) {
  const data = await requestJson('/api/users', { method: 'POST', body: { email, password, campusId } });
  return data?.user || null;
}

/** `{ campusId }` and/or `{ disabled }` for an ADMIN account. */
export async function updateAdmin(userId, patch) {
  const data = await requestJson(`/api/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: patch });
  return data?.user || null;
}
