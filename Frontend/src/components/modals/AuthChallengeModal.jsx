import React, { useEffect, useRef, useState } from 'react';
import { Fingerprint, Lock, RefreshCw, ShieldCheck } from 'lucide-react';

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
      request.action();
      onClose();
    } catch (e) {
      setError(e?.message || 'Passkey authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleAuth = (e) => {
    e.preventDefault();
    setLoading(true);
    // Simulate Passkey/WebAuthn cryptographic delay
    setTimeout(() => {
      request.action();
      onClose();
    }, 800);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-md" onClick={onClose} />
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full max-w-sm relative z-10 overflow-hidden border-2 animate-in zoom-in-95 duration-200 ${
          request.isDestructive ? 'border-rose-500' : 'border-[#0B1B3D]'
        }`}
      >
        <div
          className={`p-6 text-center ${request.isDestructive ? 'bg-rose-50' : 'bg-slate-50'} border-b border-slate-100`}
        >
          <div
            className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 shadow-inner ${
              request.isDestructive ? 'bg-rose-100 text-rose-600' : 'bg-blue-100 text-blue-600'
            }`}
          >
            <Fingerprint className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-bold text-slate-900 tracking-tight">Authorization Required</h2>
          <p className="text-xs text-slate-500 font-mono uppercase bg-white px-2 py-1 rounded border border-slate-200 inline-block mt-3">
            {request.intent}
          </p>
        </div>

        <div className="p-6">
          <div className="bg-white border border-slate-200 rounded-xl p-1 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMethod('passkey')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${
                method === 'passkey' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              Passkey
            </button>
            <button
              type="button"
              onClick={() => setMethod('pin')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${
                method === 'pin' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              PIN
            </button>
          </div>

          {error && (
            <div className="mt-4 bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-700 font-medium">
              {error}
            </div>
          )}

          {method === 'passkey' ? (
            <div className="mt-5">
              <div className="text-sm text-slate-700 font-semibold flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-slate-400" /> Authenticate with device passkey
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Uses the OS/biometric prompt when available. (Best option in a browser UI.)
              </p>

              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 py-2.5 rounded-lg text-sm font-bold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePasskeyAuth}
                  disabled={loading}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-all text-white shadow-sm flex items-center justify-center gap-2 ${
                    loading
                      ? 'bg-slate-400 cursor-wait'
                      : request.isDestructive
                        ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-500/30'
                        : 'bg-[#0B1B3D] hover:bg-[#152754] shadow-blue-900/30'
                  }`}
                >
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  {loading ? 'Waiting…' : 'Use Passkey'}
                </button>
              </div>

              {!supportsPasskey && <div className="mt-3 text-xs text-slate-500">Passkeys aren’t available here; use the PIN fallback.</div>}
              {request.isDestructive && (
                <div className="mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg p-3 font-medium">
                  Destructive action: passkey is recommended.
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleAuth} className="mt-5">
              <label className="flex w-full items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                <Lock className="w-4 h-4 text-slate-400" /> Enter PIN
              </label>
              <input
                ref={inputRef}
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="••••••"
                inputMode="numeric"
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-4 py-3 text-center tracking-[0.5em] font-mono text-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all shadow-inner"
                required
                autoComplete="off"
              />
              <div className="mt-2 text-xs text-slate-500">Minimum 6 digits recommended.</div>
              <div className="mt-6 flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 py-2.5 rounded-lg text-sm font-bold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || pin.length < 6}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-all text-white shadow-sm flex items-center justify-center gap-2 ${
                    loading
                      ? 'bg-slate-400 cursor-wait'
                      : request.isDestructive
                        ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-500/30'
                        : 'bg-[#0B1B3D] hover:bg-[#152754] shadow-blue-900/30'
                  }`}
                >
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  {loading ? 'Verifying…' : 'Authenticate'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
