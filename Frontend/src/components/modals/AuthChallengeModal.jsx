import React, { useEffect, useRef, useState } from 'react';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Fingerprint, Lock, RefreshCw, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.jsx';
import { Input } from '@/components/ui/input.jsx';

import { pinAuth, webauthnStatus, webauthnAuthOptions, webauthnVerify } from '@/lib/api/auth.js';

function webAuthnErrorMessage(e) {
  if (!e) return 'Passkey authentication failed.';
  if (e.name === 'NotAllowedError') return 'Fingerprint authentication was cancelled or timed out. Try again.';
  if (e.name === 'SecurityError') return 'Security error — passkeys require HTTPS or localhost.';
  return e.message || 'Passkey authentication failed.';
}

export default function AuthChallengeModal({ request, onClose }) {
  const [method, setMethod] = useState('passkey');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  // Server-verified registration status (not trusted from localStorage — see
  // Backend/src/controllers/webauthn_controller.js:status).
  const [hasRegisteredPasskey, setHasRegisteredPasskey] = useState(false);

  const supportsPasskey = typeof window !== 'undefined' && browserSupportsWebAuthn();

  useEffect(() => {
    let cancelled = false;
    webauthnStatus()
      .then((data) => { if (!cancelled) setHasRegisteredPasskey(!!data?.registered); })
      .catch(() => { /* leave as unregistered */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setError('');
    if (method === 'pin') inputRef.current?.focus();
  }, [method]);

  const handlePasskeyAuth = async () => {
    setLoading(true);
    setError('');
    try {
      if (!supportsPasskey) throw new Error('Passkeys are not supported in this browser. Switch to the PIN tab.');
      if (!window.isSecureContext) throw new Error('Passkeys require a secure context (HTTPS or localhost).');
      if (!hasRegisteredPasskey) throw new Error('No fingerprint registered yet. Go to Profile → Security to register one first.');

      const { options } = await webauthnAuthOptions();
      const assertion = await startAuthentication(options);
      // Signature is verified server-side against the stored public key —
      // this call only succeeds if the backend's cryptographic check passes.
      await webauthnVerify(assertion);

      await Promise.resolve(request.action());
      onClose();
    } catch (e) {
      setError(webAuthnErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await pinAuth(pin);
      await Promise.resolve(request.action());
      onClose();
    } catch (e) {
      setError(e?.message || 'Authorization failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-sm p-0 overflow-hidden">
        <div
          className={
            request.isDestructive
              ? 'p-6 text-center bg-destructive/10 border-b border-border/60'
              : 'p-6 text-center bg-muted/30 border-b border-border/60'
          }
        >
          <div
            className={
              request.isDestructive
                ? 'mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 bg-destructive/15 text-destructive'
                : 'mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 bg-primary/10 text-primary'
            }
          >
            <Fingerprint className="w-6 h-6" />
          </div>
          <DialogTitle>Authorization Required</DialogTitle>
          <div className="mt-3">
            <Badge variant="outline" className="font-mono uppercase text-xs">
              {request.intent}
            </Badge>
          </div>
          {/* What the act does that the intent label does not say — shown before the
              operator authorises it, not after. */}
          {request.warning && (
            <div
              role="alert"
              data-auth-warning
              className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs font-medium text-amber-900"
            >
              {request.warning}
            </div>
          )}
        </div>

        <div className="p-6">
          <div className="rounded-xl border border-border/60 bg-muted/20 p-1 flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={method === 'passkey' ? 'default' : 'ghost'}
              className="flex-1"
              onClick={() => setMethod('passkey')}
            >
              Passkey
            </Button>
            <Button
              type="button"
              size="sm"
              variant={method === 'pin' ? 'default' : 'ghost'}
              className="flex-1"
              onClick={() => setMethod('pin')}
            >
              PIN
            </Button>
          </div>

          {error && (
            <div className="mt-4 bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm text-destructive font-medium">
              {error}
            </div>
          )}

          {method === 'passkey' ? (
            <div className="mt-5">
              <div className="text-sm text-foreground font-medium flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-muted-foreground" />
                Authenticate with fingerprint
              </div>

              {!supportsPasskey ? (
                <div className="mt-2 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                  Passkeys are not supported in this browser. Please use the PIN tab instead.
                </div>
              ) : !hasRegisteredPasskey ? (
                <div className="mt-2 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                  No fingerprint registered yet. Go to{' '}
                  <span className="font-semibold">Profile → Security</span> to register one, then
                  come back here.
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">
                  Your device will prompt for biometric verification (fingerprint / face / PIN).
                </p>
              )}

              <div className="mt-4 flex gap-3">
                <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handlePasskeyAuth}
                  disabled={loading || !supportsPasskey}
                  variant={request.isDestructive ? 'destructive' : 'default'}
                  className="flex-1"
                >
                  {loading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-4 h-4" />
                  )}
                  {loading ? 'Waiting…' : 'Use Fingerprint'}
                </Button>
              </div>

              {request.isDestructive && (
                <div className="mt-3 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3 font-medium">
                  Destructive action: biometric or PIN confirmation required.
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleAuth} className="mt-5">
              <div className="flex w-full items-center gap-2 text-sm font-medium text-foreground mb-2">
                <Lock className="w-4 h-4 text-muted-foreground" /> Enter PIN
              </div>
              <Input
                ref={inputRef}
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="••••••"
                inputMode="numeric"
                required
                autoComplete="off"
                className="h-12 text-center font-mono text-xl tracking-widest bg-muted/20"
              />
              <div className="mt-2 text-xs text-muted-foreground">Enter your admin PIN to authorize.</div>
              <div className="mt-6 flex gap-3">
                <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={loading || String(pin).trim().length === 0}
                  variant={request.isDestructive ? 'destructive' : 'default'}
                  className="flex-1"
                >
                  {loading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-4 h-4" />
                  )}
                  {loading ? 'Verifying…' : 'Authenticate'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
