import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Fingerprint,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card } from '@/components/ui/card.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Switch } from '@/components/ui/switch.jsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.jsx';
import { useAppActions, useAppState } from '@/context/appContext.js';
import { pinAuth } from '@/lib/api/auth.js';

// ── WebAuthn helpers ───────────────────────────────────────────────────────────
function base64UrlEncode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function randomBytes(len) {
  const bytes = new Uint8Array(len);
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random unavailable.');
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function getStoredCredentialId() {
  try { return localStorage.getItem('robotx_passkey_cred'); } catch { return null; }
}

function storeCredentialId(rawIdBuffer) {
  try { localStorage.setItem('robotx_passkey_cred', base64UrlEncode(rawIdBuffer)); } catch { /* ignore */ }
}

function webAuthnRegisterErrorMessage(e) {
  if (!e) return 'Registration failed.';
  if (e.name === 'NotAllowedError') return 'Fingerprint registration was cancelled or timed out. Try again.';
  if (e.name === 'InvalidStateError') return 'This authenticator is already registered. Try re-registering.';
  if (e.name === 'NotSupportedError') return 'Your device does not support platform biometrics.';
  if (e.name === 'SecurityError') return 'Security error — fingerprint registration requires HTTPS or localhost.';
  if (e.name === 'AbortError') return 'Registration was aborted. Try again.';
  return e.message || 'Fingerprint registration failed.';
}

// ── Formatters ────────────────────────────────────────────────────────────────
function getEmailInitial(email) {
  const local = String(email || '').trim().split('@')[0] || '';
  return local.charAt(0).toUpperCase() || 'U';
}

function formatRole(role) {
  const r = String(role || '').trim();
  if (!r) return 'User';
  return r
    .toLowerCase()
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join(' ');
}

// ── FingerprintSection ────────────────────────────────────────────────────────
// Step 1: verify PIN  →  Step 2: register fingerprint via WebAuthn
function FingerprintSection() {
  const supportsPasskey =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    !!navigator?.credentials;

  // 'idle' | 'pin-entry' | 'verifying' | 'ready' | 'registering' | 'done'
  const [step, setStep] = useState('idle');
  const [fpPin, setFpPin] = useState('');
  const [fpError, setFpError] = useState('');
  const [fpRegistered, setFpRegistered] = useState(() => !!getStoredCredentialId());
  const pinRef = useRef(null);

  function startFlow() {
    setFpPin('');
    setFpError('');
    setStep('pin-entry');
    setTimeout(() => pinRef.current?.focus(), 50);
  }

  function cancelFlow() {
    setFpPin('');
    setFpError('');
    setStep('idle');
  }

  async function handleVerifyPin(e) {
    e.preventDefault();
    if (!fpPin.trim()) return;
    setStep('verifying');
    setFpError('');
    try {
      await pinAuth(fpPin);
      setStep('ready');
    } catch (err) {
      setFpError(err?.message || 'PIN verification failed. Check your PIN and try again.');
      setStep('pin-entry');
      setTimeout(() => pinRef.current?.focus(), 50);
    }
  }

  async function handleRegisterFingerprint() {
    if (!supportsPasskey) {
      setFpError('Passkeys/biometrics are not supported in this browser.');
      return;
    }
    if (!window.isSecureContext) {
      setFpError('Fingerprint registration requires a secure context (HTTPS or localhost).');
      return;
    }

    setStep('registering');
    setFpError('');
    try {
      const challenge = randomBytes(32);
      const userId = randomBytes(16);
      const rpId = window.location.hostname;

      const cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'RobotX Command Console', id: rpId },
          user: {
            id: userId,
            name: 'commander@robotx.local',
            displayName: 'Commander',
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },   // ES256
            { type: 'public-key', alg: -257 },  // RS256
          ],
          timeout: 60000,
          attestation: 'none',
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred',
          },
        },
      });

      if (!cred) throw new Error('Registration was cancelled.');

      storeCredentialId(cred.rawId);
      setFpRegistered(true);
      setStep('done');
    } catch (err) {
      setFpError(webAuthnRegisterErrorMessage(err));
      setStep('ready');
    }
  }

  // Auto-reset from 'done' back to 'idle' after a brief success display
  // (user can click "Register Again" manually too)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Fingerprint className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Fingerprint (Passkey)</span>
        </div>
        {fpRegistered ? (
          <Badge variant="secondary" className="gap-1.5 text-xs text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-950/40 border-green-200 dark:border-green-800">
            <CheckCircle2 className="w-3 h-3" /> Registered
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs text-muted-foreground">
            Not registered
          </Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {fpRegistered
          ? 'Your fingerprint is registered and can be used for Authorization Required prompts. You can re-register to update it.'
          : 'Register your device fingerprint to use it for Authorization Required prompts instead of typing your PIN each time.'}
      </p>

      {!supportsPasskey && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
          Passkeys are not supported in this browser. Try Chrome, Edge, or Safari on a device with biometrics.
        </div>
      )}

      {fpError && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3 font-medium">
          {fpError}
        </div>
      )}

      {/* ── Step 0: idle ────────────────────────────────────────────── */}
      {step === 'idle' && supportsPasskey && (
        <Button type="button" size="sm" variant="outline" onClick={startFlow} className="w-full">
          <Fingerprint className="w-4 h-4" />
          {fpRegistered ? 'Re-register Fingerprint' : 'Register Fingerprint'}
        </Button>
      )}

      {/* ── Step 1: PIN entry ────────────────────────────────────────── */}
      {(step === 'pin-entry' || step === 'verifying') && (
        <form onSubmit={handleVerifyPin} className="space-y-2">
          <div className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            Enter your admin PIN to proceed
          </div>
          <Input
            ref={pinRef}
            type="password"
            value={fpPin}
            onChange={(e) => setFpPin(e.target.value)}
            placeholder="••••••"
            inputMode="numeric"
            autoComplete="off"
            required
            className="h-10 text-center font-mono text-lg tracking-widest bg-muted/20"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="flex-1"
              onClick={cancelFlow}
              disabled={step === 'verifying'}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="flex-1"
              disabled={step === 'verifying' || !fpPin.trim()}
            >
              {step === 'verifying' ? (
                <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Verifying…</>
              ) : (
                'Verify PIN'
              )}
            </Button>
          </div>
        </form>
      )}

      {/* ── Step 2: PIN verified — ready to register fingerprint ──────── */}
      {(step === 'ready' || step === 'registering') && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg p-2.5">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            PIN verified. Now register your fingerprint using the button below.
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="flex-1"
              onClick={cancelFlow}
              disabled={step === 'registering'}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="flex-1"
              onClick={handleRegisterFingerprint}
              disabled={step === 'registering'}
            >
              {step === 'registering' ? (
                <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Scanning…</>
              ) : (
                <><Fingerprint className="w-3.5 h-3.5" /> Register Fingerprint</>
              )}
            </Button>
          </div>
          {step === 'registering' && (
            <p className="text-xs text-muted-foreground text-center">
              Follow your device&apos;s biometric prompt…
            </p>
          )}
        </div>
      )}

      {/* ── Step 3: done ─────────────────────────────────────────────── */}
      {step === 'done' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg p-3 font-medium">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            Fingerprint registered successfully! It will be used for Authorization Required prompts.
          </div>
          <Button type="button" size="sm" variant="outline" className="w-full" onClick={cancelFlow}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}

// ── ProfilePage ───────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const { session, preferences } = useAppState();
  const { updatePreferences } = useAppActions();

  const email = session?.user?.email || session?.identity || '';
  const role = session?.user?.role || '';
  const roleLabel = formatRole(role);
  const initial = getEmailInitial(email);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-lg font-medium">Profile</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Commander identity, security, and console preferences.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10">
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <div className="text-right">
            <div className="text-sm font-medium text-foreground">{roleLabel}</div>
            <div className="text-xs text-muted-foreground font-mono">{email || '—'}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-4">
          {/* Account card */}
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-muted-foreground">Account</div>
                <div className="mt-2 text-sm font-medium">{roleLabel}</div>
                <div className="text-xs text-muted-foreground font-mono mt-1">{email || '—'}</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-muted-foreground">Role</div>
                <div className="mt-2">
                  <Badge variant="secondary" className="gap-2">
                    <ShieldCheck className="w-4 h-4" /> {roleLabel}
                  </Badge>
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <Card className="p-4 bg-muted/30">
                <div className="text-sm text-muted-foreground">Workspace</div>
                <div className="mt-2 text-sm font-medium">RobotX Console</div>
                <div className="text-xs text-muted-foreground mt-1">Super Admin</div>
              </Card>
              <Card className="p-4 bg-muted/30">
                <div className="text-sm text-muted-foreground">Region</div>
                <div className="mt-2 text-sm font-medium">Local Demo</div>
                <div className="text-xs text-muted-foreground mt-1">localhost environment</div>
              </Card>
            </div>
          </Card>

          {/* Security card */}
          <Card className="p-5">
            <div className="text-sm text-muted-foreground mb-4">Security</div>

            <div className="space-y-5 divide-y divide-border/40">
              {/* Fingerprint registration — interactive */}
              <FingerprintSection />

              {/* PIN fallback — informational */}
              <div className="pt-4 flex items-start gap-3">
                <div className="mt-0.5 p-1.5 rounded-md bg-muted/50 text-muted-foreground">
                  <Lock className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">PIN Fallback</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Available if fingerprint is not registered or not supported. Verified against your
                    account PIN stored in the database.
                  </div>
                </div>
              </div>

              {/* Destructive guard — informational */}
              <div className="pt-4 flex items-start gap-3">
                <div className="mt-0.5 p-1.5 rounded-md bg-muted/50 text-muted-foreground">
                  <ShieldAlert className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">Destructive Guard</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Stop-all, retire, and cancel operations always require authorization (fingerprint
                    or PIN) before executing.
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          {/* Preferences card */}
          <Card className="p-5">
            <div className="text-sm text-muted-foreground">Preferences</div>
            <div className="mt-3 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-foreground font-medium">Notifications</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Enable the bell menu in the top bar.</div>
                </div>
                <Switch
                  checked={!!preferences?.notificationsEnabled}
                  onCheckedChange={(checked) => updatePreferences({ notificationsEnabled: !!checked })}
                  aria-label="Toggle notifications"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-foreground font-medium">Theme</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Preference is saved for your account.</div>
                </div>
                <Select
                  value={preferences?.theme || 'system'}
                  onValueChange={(value) => updatePreferences({ theme: value })}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="System" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-foreground font-medium">Audit Log</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Controls in-app event logging.</div>
                </div>
                <Switch
                  checked={!!preferences?.auditLogEnabled}
                  onCheckedChange={(checked) => updatePreferences({ auditLogEnabled: !!checked })}
                  aria-label="Toggle audit log"
                />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
