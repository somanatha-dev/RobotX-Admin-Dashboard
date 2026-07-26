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

// ── WebAuthn / passkey (server-verified) ────────────────────────────────────
export async function webauthnStatus() {
  return requestJson('/api/auth/webauthn/status', { errorMessage: 'Could not check passkey status' });
}

export async function webauthnRegisterOptions() {
  return requestJson('/api/auth/webauthn/register-options', {
    method: 'POST',
    errorMessage: 'Could not start passkey registration',
  });
}

export async function webauthnRegister(pin, response) {
  return requestJson('/api/auth/webauthn/register', {
    method: 'POST',
    body: { pin, response },
    errorMessage: 'Passkey registration failed',
  });
}

export async function webauthnAuthOptions() {
  return requestJson('/api/auth/webauthn/auth-options', {
    method: 'POST',
    errorMessage: 'Could not start passkey authentication',
  });
}

export async function webauthnVerify(response) {
  return requestJson('/api/auth/webauthn/verify', {
    method: 'POST',
    body: { response },
    errorMessage: 'Passkey authentication failed',
  });
}
