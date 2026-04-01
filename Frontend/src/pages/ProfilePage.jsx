import React from 'react';
import { Fingerprint, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';

export default function ProfilePage() {
  return (
    <div className="h-full p-6 lg:p-8 overflow-y-auto bg-slate-50">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Profile</h1>
            <p className="text-sm text-slate-500 mt-1">Commander identity, security, and console preferences.</p>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-900 text-white flex items-center justify-center text-sm font-bold">RX</div>
            <div className="text-right">
              <div className="text-sm font-bold text-slate-900">Commander</div>
              <div className="text-xs text-slate-500 font-mono">commander@robotx.local</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Account</div>
                  <div className="mt-2 text-sm font-semibold text-slate-900">Commander</div>
                  <div className="text-xs text-slate-500 font-mono mt-1">commander@robotx.local</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Role</div>
                  <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-700 text-xs font-bold">
                    <ShieldCheck className="w-4 h-4" /> Commander
                  </div>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Workspace</div>
                  <div className="mt-2 text-sm font-semibold text-slate-900">RobotX Console</div>
                  <div className="text-xs text-slate-500 mt-1">System v2.4.1-prod</div>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Region</div>
                  <div className="mt-2 text-sm font-semibold text-slate-900">Local Demo</div>
                  <div className="text-xs text-slate-500 mt-1">localhost environment</div>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Security</div>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-gradient-to-br from-blue-50 via-white to-white border border-blue-100 rounded-xl p-4 relative overflow-hidden">
                  <Fingerprint className="absolute -right-5 -bottom-5 w-16 h-16 text-blue-700 opacity-[0.08]" />
                  <div className="text-sm font-bold text-slate-900">Passkey</div>
                  <div className="text-xs text-slate-500 mt-1">Preferred for privileged commands.</div>
                </div>
                <div className="bg-gradient-to-br from-amber-50 via-white to-white border border-amber-100 rounded-xl p-4 relative overflow-hidden">
                  <Lock className="absolute -right-5 -bottom-5 w-16 h-16 text-amber-700 opacity-[0.08]" />
                  <div className="text-sm font-bold text-slate-900">PIN Fallback</div>
                  <div className="text-xs text-slate-500 mt-1">Available if passkey isn’t supported.</div>
                </div>
                <div className="bg-gradient-to-br from-rose-50 via-white to-white border border-rose-100 rounded-xl p-4 relative overflow-hidden">
                  <ShieldAlert className="absolute -right-5 -bottom-5 w-16 h-16 text-rose-700 opacity-[0.08]" />
                  <div className="text-sm font-bold text-slate-900">Destructive Guard</div>
                  <div className="text-xs text-slate-500 mt-1">Stops/retire require authorization.</div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Preferences</div>
              <div className="mt-3 space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-slate-600 font-medium">Notifications</span>
                  <span className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-md">Enabled</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600 font-medium">Theme</span>
                  <span className="text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-md">System</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600 font-medium">Audit Log</span>
                  <span className="text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-md">On</span>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Session</div>
              <div className="mt-3 text-sm text-slate-700 font-medium">Signed in locally for this demo environment.</div>
              <div className="mt-4">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Last Verified</div>
                <div className="mt-2 text-sm font-mono font-bold text-slate-900">Just now</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
