export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

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
    const message = data?.message || errorMessage;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}
