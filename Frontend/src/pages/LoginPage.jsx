import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, RefreshCw, ShieldAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { useAppActions } from '../context/appContext.js';

export default function LoginPage() {
  const rrNavigate = useNavigate();
  const { login } = useAppActions();

  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [error, setError] = useState('');

  const exitTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) window.clearTimeout(exitTimerRef.current);
    };
  }, []);

  const canLogin = identity.trim().length > 0 && password.trim().length > 0;
  const busy = loading || isExiting;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canLogin || busy) return;

    setLoading(true);
    setError('');

    try {
      await login(identity.trim(), password, { navigate: false });

      setIsExiting(true);
      exitTimerRef.current = window.setTimeout(() => {
        rrNavigate('/');
      }, 360);
    } catch (err) {
      setError(err?.message || 'Invalid email or password');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-8 overflow-hidden overscroll-none">
      {/* ambient background */}
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute -top-56 -left-56 w-140 h-140 rounded-full bg-blue-200/35 blur-3xl" />
        <div className="absolute -bottom-56 -right-56 w-140 h-140 rounded-full bg-indigo-200/30 blur-3xl" />
      </div>

      <div className="relative w-full max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={isExiting ? { opacity: 0, scale: 0.96 } : { opacity: 1, scale: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="rounded-2xl shadow-xl border border-border/60 overflow-hidden bg-card"
        >
          <div className="grid grid-cols-1 md:grid-cols-[55%_45%]">
            {/* LEFT: Branding */}
            <div className="relative p-10 text-white overflow-hidden bg-linear-to-br from-slate-950 via-slate-900 to-indigo-900">
              <div className="absolute inset-0">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,rgba(255,255,255,0.14),transparent_55%)]" />
                <div className="absolute inset-0 bg-white/5 backdrop-blur-xl" />
              </div>

              <div className="relative">
                <div className="inline-flex items-center gap-2 bg-white/10 border border-white/15 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide">
                  <ShieldAlert className="w-4 h-4" /> RobotX
                </div>

                <div className="mt-8 max-w-sm space-y-3">
                  <div className="text-2xl font-semibold tracking-tight">
                    Control your robotic fleet with precision.
                  </div>
                  <div className="text-sm text-white/75">
                    Real-time coordination, secure access, and intelligent automation in one unified system.
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT: Form */}
            <div className="p-10 bg-background">
              <div className="space-y-1">
                <div className="text-2xl font-semibold tracking-tight text-foreground">Welcome back</div>
                <div className="text-sm text-muted-foreground">Sign in to continue</div>
              </div>

              <form onSubmit={handleSubmit} className="mt-8 space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="email" className="block">
                    Email
                  </Label>
                  <Input
                    id="email"
                    value={identity}
                    onChange={(e) => setIdentity(e.target.value)}
                    placeholder="admin@robotx.local"
                    autoComplete="username"
                    disabled={busy}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password" className="block">
                    Password
                  </Label>

                  <div className="relative">
                    <Input
                      id="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      disabled={busy}
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 px-0 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword((v) => !v)}
                      disabled={busy}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                {error ? (
                  <div className="text-sm font-medium text-destructive">{error}</div>
                ) : null}

                <Button
                  type="submit"
                  disabled={!canLogin || busy}
                  className="w-full h-11 rounded-xl transition-all duration-200 hover:shadow-md active:scale-[0.98]"
                >
                  {loading ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <span className="h-4 w-4" aria-hidden />
                  )}
                  {loading ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            </div>
          </div>
        </motion.div>
      </div>

      <AnimatePresence>
        {isExiting ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-background/70 backdrop-blur-sm flex items-center justify-center"
          >
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Preparing dashboard…
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
