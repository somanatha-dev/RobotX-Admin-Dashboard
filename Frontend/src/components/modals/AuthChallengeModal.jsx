import React, { useEffect, useRef, useState } from 'react';
import { Fingerprint, Lock, RefreshCw, ShieldCheck } from 'lucide-react';

import { Badge } from '../ui/badge.jsx';
import { Button } from '../ui/button.jsx';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.jsx';
import { Input } from '../ui/input.jsx';

import { pinAuth } from '../../lib/api/auth.js';

export default function AuthChallengeModal({ request, onClose }) {
  const [method, setMethod] = useState('passkey'); // 'passkey' | 'pin'
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    setError('');
    if (method === 'pin') inputRef.current?.focus();
  }, [method]);

  const supportsPasskey =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials;

  const base64UrlEncode = (arrayBuffer) => {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  };

  const base64UrlDecode = (base64url) => {
    const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '==='.slice((base64.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };

  const randomBytes = (len) => {
    const bytes = new Uint8Array(len);
    if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random is unavailable in this environment.');
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  };

  const getStoredCredentialId = () => {
    try {
      return localStorage.getItem('robotx_passkey_cred');
    } catch {
      return null;
    }
  };

  const storeCredentialId = (rawIdBuffer) => {
    try {
      localStorage.setItem('robotx_passkey_cred', base64UrlEncode(rawIdBuffer));
    } catch {
      // ignore
    }
  };

  const ensurePasskeyRegistered = async () => {
    if (!supportsPasskey) throw new Error('Passkeys are not supported in this browser.');
    if (!window.isSecureContext) throw new Error('Passkeys require a secure context (HTTPS or localhost).');

    const existing = getStoredCredentialId();
    if (existing) return existing;

    const challenge = randomBytes(32);
    const userId = randomBytes(16);
    const rpId = window.location.hostname;

    const publicKey = {
      challenge,
      rp: { name: 'RobotX Command Console', id: rpId },
      user: {
        id: userId,
        name: 'commander@robotx.local',
        displayName: 'Commander',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'preferred',
      },
    };

    const cred = await navigator.credentials.create({ publicKey });
    if (!cred) throw new Error('Passkey registration was cancelled.');
    storeCredentialId(cred.rawId);
    return getStoredCredentialId();
  };

  const handlePasskeyAuth = async () => {
    setLoading(true);
    setError('');
    try {
      const credId = await ensurePasskeyRegistered();
      const challenge = randomBytes(32);

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          timeout: 60000,
          userVerification: 'required',
          allowCredentials: [{ type: 'public-key', id: new Uint8Array(base64UrlDecode(credId)) }],
        },
      });

      if (!assertion) throw new Error('Passkey authentication was cancelled.');

      await Promise.resolve(request.action());
      onClose();
    } catch (e) {
      setError(e?.message || 'Passkey authentication failed.');
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
                <Fingerprint className="w-4 h-4 text-muted-foreground" /> Authenticate with device passkey
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Uses the OS/biometric prompt when available. (Best option in a browser UI.)
              </p>

              <div className="mt-4 flex gap-3">
                <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handlePasskeyAuth}
                  disabled={loading}
                  variant={request.isDestructive ? 'destructive' : 'default'}
                  className="flex-1"
                >
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  {loading ? 'Waiting…' : 'Use Passkey'}
                </Button>
              </div>

              {!supportsPasskey && (
                <div className="mt-3 text-xs text-muted-foreground">
                  Passkeys aren’t available here; use the PIN fallback.
                </div>
              )}
              {request.isDestructive && (
                <div className="mt-3 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3 font-medium">
                  Destructive action: passkey is recommended.
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
              <div className="mt-2 text-xs text-muted-foreground">Minimum 6 digits recommended.</div>
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
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
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
