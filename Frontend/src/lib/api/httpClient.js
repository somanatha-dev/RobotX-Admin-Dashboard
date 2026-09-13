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

export async function requestJson(path, { method = 'GET', body, errorMessage = 'Request failed' } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    // `detail` is the second shape the backend answers refusals in: the §23.4 authorisation
    // gate replies `{ ok: false, error: "Forbidden", detail: "…" }` with no `message`, so
    // without this fallback every elevated-role refusal in the app reached the operator as
    // the generic "Request failed" and told them nothing about why.
    const message = data?.message || data?.detail || errorMessage;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}
