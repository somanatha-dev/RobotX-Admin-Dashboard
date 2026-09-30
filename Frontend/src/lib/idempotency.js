/**
 * FS-08 — one `Idempotency-Key` per task-creation draft.
 *
 * ── The backend contract (tasks.controller.assignTask → intake.admit) ───────
 * `POST /api/tasks/assign` reads an optional `Idempotency-Key` header. A second submission
 * under a key already accepted is answered **200** with the *original* task and
 * `intake.outcome: "DUPLICATE"`, and its own rows are rolled back — so a retry cannot
 * create a second task. The key is global on the backend (`client:<key>`), which is why it
 * must be random: a key derived from the task's text, or one key per session, would merge
 * two genuinely different tasks into the first.
 *
 * `crypto.getRandomValues` rather than `crypto.randomUUID`: the latter exists only in a
 * secure context, and the dashboard is also opened over plain http on a LAN address.
 */

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** @returns {string} a random RFC 4122 version-4 UUID */
export function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The intake outcome that means "already accepted under this key; nothing new was created". */
export const DUPLICATE_OUTCOME = 'DUPLICATE';
