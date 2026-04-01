import React, { useState } from 'react';
import { ArrowLeft, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAppActions } from '../context/appContext.js';

export default function LoginPage() {
  const { login } = useAppActions();
  const [step, setStep] = useState('identity'); // 'identity' | 'password'
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const canContinue = identity.trim().length > 0;
  const canLogin = password.trim().length > 0;

  const handleNext = (e) => {
    e.preventDefault();
    if (!canContinue) return;
    setStep('password');
  };

  const handleBack = (e) => {
    e.preventDefault();
    setPassword('');
    setStep('identity');
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canLogin) return;
    setLoading(true);
    setTimeout(() => {
      login(identity.trim());
      setLoading(false);
    }, 450);
  };

  return (
    <div className="fixed inset-0 w-full h-full bg-slate-50 overflow-hidden overscroll-none">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-48 -left-48 w-[560px] h-[560px] bg-blue-200/35 blur-3xl rounded-full" />
        <div className="absolute -bottom-48 -right-48 w-[560px] h-[560px] bg-slate-200/60 blur-3xl rounded-full" />
      </div>

      <div className="relative h-full w-full flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-4xl max-h-[calc(100vh-3rem)] bg-white border border-slate-200 rounded-3xl shadow-xl overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-2 h-full">
            <div className="relative p-8 sm:p-10 bg-gradient-to-br from-slate-950 via-slate-900 to-blue-900 text-white overflow-hidden">
              <div className="absolute inset-0 opacity-20">
                <div className="absolute -top-24 -left-24 w-72 h-72 border-2 border-white/30 rounded-full" />
                <div className="absolute top-20 right-10 w-56 h-56 border-2 border-white/20 rounded-full" />
                <div className="absolute -bottom-28 left-24 w-80 h-80 border-2 border-white/20 rounded-full" />
              </div>
              <div className="relative">
                <div className="inline-flex items-center gap-2 bg-white/15 border border-white/20 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide">
                  <ShieldAlert className="w-4 h-4" /> RobotX
                </div>
                <div className="mt-8 text-3xl font-extrabold tracking-tight leading-snug">
                  Simple, secure
                  <br />
                  command console.
                </div>
                <div className="mt-4 text-sm text-white/85 font-medium max-w-sm">
                  Access fleet controls with passkey/PIN authorization for privileged actions.
                </div>
                <div className="mt-10 text-xs text-white/75 font-mono">v2.4.1-prod</div>
              </div>
            </div>

            <div className="p-8 sm:p-10">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold text-slate-900 tracking-tight">Welcome</div>
                  <div className="text-sm text-slate-500 mt-1">Sign in to continue.</div>
                </div>
              </div>

              <div className="mt-8 overflow-hidden">
                <div
                  className={`flex w-[200%] transition-transform duration-500 ease-out will-change-transform ${
                    step === 'password' ? '-translate-x-1/2' : 'translate-x-0'
                  }`}
                >
                  {/* STEP 1 */}
                  <form onSubmit={handleNext} className="w-1/2 pr-4">
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Username</label>
                    <input
                      value={identity}
                      onChange={(e) => setIdentity(e.target.value)}
                      placeholder="commander"
                      className="w-full bg-white border-b border-slate-200 px-0 py-3 text-slate-900 font-medium focus:outline-none focus:border-blue-600 transition-colors"
                      autoComplete="username"
                      disabled={loading}
                    />
                    <div className="mt-6">
                      <button
                        type="submit"
                        disabled={!canContinue || loading}
                        className={`w-full py-3 rounded-xl font-bold text-sm transition-all ${
                          !canContinue || loading
                            ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                            : 'bg-slate-900 hover:bg-slate-800 text-white shadow-sm'
                        }`}
                      >
                        Next
                      </button>
                    </div>
                  </form>

                  {/* STEP 2 */}
                  <form onSubmit={handleSubmit} className="w-1/2 pl-4">
                    <button
                      type="button"
                      onClick={handleBack}
                      className="text-xs font-bold text-slate-600 hover:text-slate-900 inline-flex items-center gap-2"
                    >
                      <ArrowLeft className="w-4 h-4" /> Back
                    </button>
                    <div className="mt-4 text-2xl font-bold text-slate-900 tracking-tight">Enter Password</div>
                    <div className="text-sm text-slate-500 mt-1">
                      Welcome back, <span className="font-mono font-bold text-slate-700">{identity.trim() || '—'}</span>
                    </div>

                    <div className="mt-8">
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Password</label>
                      <input
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        type="password"
                        placeholder="Enter your password"
                        className="w-full bg-white border-b border-slate-200 px-0 py-3 text-slate-900 font-medium focus:outline-none focus:border-blue-600 transition-colors"
                        autoComplete="current-password"
                        disabled={loading}
                      />
                    </div>

                    <div className="mt-8">
                      <button
                        type="submit"
                        disabled={!canLogin || loading}
                        className={`w-full py-3 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                          !canLogin || loading
                            ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                            : 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm'
                        }`}
                      >
                        {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                        {loading ? 'Signing in…' : 'Log In'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>

              <div className="mt-8 text-xs text-slate-500">No Google sign-in, no signup, no reset in this demo.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
