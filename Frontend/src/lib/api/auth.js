const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function login({ email, password }) {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    const message = data?.message || 'Login failed';
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return data;
}

export async function me() {
  const res = await fetch(`${API_URL}/api/auth/me`, {
    method: 'GET',
    credentials: 'include',
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    const message = data?.message || 'Unauthorized';
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return data;
}

export async function logout() {
  const res = await fetch(`${API_URL}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });

  // Even if backend responds with an error, we clear local session on the client.
  const data = await readJsonSafe(res);
  if (!res.ok) {
    const message = data?.message || 'Logout failed';
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return data;
}

export async function pinAuth(pin) {
  const res = await fetch(`${API_URL}/api/auth/pin-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ pin }),
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    const message = data?.message || 'PIN authorization failed';
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return data;
}
