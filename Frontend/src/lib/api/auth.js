import { requestJson } from './httpClient.js';

export async function login({ email, password }) {
  return requestJson('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    errorMessage: 'Login failed',
  });
}

export async function loginWithGoogle(credential) {
  return requestJson('/api/auth/google', {
    method: 'POST',
    body: { credential },
    errorMessage: 'Google sign-in failed',
  });
}

export async function me() {
  return requestJson('/api/auth/me', { errorMessage: 'Unauthorized' });
}

export async function logout() {
  return requestJson('/api/auth/logout', { method: 'POST', errorMessage: 'Logout failed' });
}

export async function pinAuth(pin) {
  return requestJson('/api/auth/pin-auth', {
    method: 'POST',
    body: { pin },
    errorMessage: 'PIN authorization failed',
  });
}
