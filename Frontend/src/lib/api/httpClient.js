// `import.meta.env` is Vite's, and it is undefined when a module is loaded by plain Node
// — which is how `src/__architecture__/` exercises the request modules without a bundler.
// Reading through a guarded reference keeps the dev and build behaviour identical (Vite
// still supplies the object) while letting the same file be imported by `npm run
// test:arch`.
const VITE_ENV = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};

export const API_URL = VITE_ENV.VITE_API_URL || 'http://localhost:3000';

async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const textOrNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * The operator-facing sentence of a refusal, taken only from what the backend sent.
 *
 * The backend answers refusals in four shapes, and all of them are read, in this order:
 *   · `{ message }` — the error middleware (every thrown 4xx; a 500 is already masked to
 *     "Internal Server Error" there, and no shape carries a stack);
 *   · `{ error, detail }` — the authorisation gates and a few controllers; `detail` is the
 *     explanation, `error` its heading;
 *   · `{ error, intake: { sentence, reason, problems } }` — task intake refusing a
 *     submission (400 INVALID, 429 DECLINED); `intake.sentence` is intake's own reason;
 *   · `{ ok: false, error }` — the HTTP rate limiter (429 "Rate limit exceeded") and a few
 *     controllers.
 * Only strings are used; nothing is composed or guessed. `null` when the body has none of
 * them, and only then does the caller's generic fallback apply.
 *
 * @param {unknown} data the parsed response body, or null
 * @returns {string|null}
 */
export function refusalMessage(data) {
  return (
    textOrNull(data?.message) ||
    textOrNull(data?.detail) ||
    textOrNull(data?.intake?.sentence) ||
    textOrNull(data?.error) ||
    null
  );
}

export async function requestJson(path, { method = 'GET', body, errorMessage = 'Request failed' } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    // FE-09: the backend's own sentence whatever shape it came in (see `refusalMessage`).
    // Intake refusals and the rate limiter used to reach the operator as the generic
    // fallback because they carry `error` / `intake.sentence` rather than `message`.
    const message = refusalMessage(data) || errorMessage;
    const err = new Error(message);
    err.status = res.status;
    // The backend's machine-readable refusal code when it sends one (for example
    // `ENGINE_CANCELLATION_UNAVAILABLE`), so a caller can tell a refusal it expects from
    // a failure without matching on the sentence.
    err.code = typeof data?.code === 'string' ? data.code : null;
    throw err;
  }
  return data;
}
