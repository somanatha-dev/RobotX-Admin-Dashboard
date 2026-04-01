import React from 'react';

export default function MetricCard({ icon: Icon, title, value, subtext, color }) {
  const tones = {
    blue: { text: 'text-slate-900', icon: 'text-emerald-700', border: 'border-slate-200', bg: 'bg-white', accent: 'bg-emerald-50' },
    emerald: { text: 'text-slate-900', icon: 'text-emerald-700', border: 'border-slate-200', bg: 'bg-white', accent: 'bg-emerald-50' },
    rose: { text: 'text-slate-900', icon: 'text-rose-700', border: 'border-slate-200', bg: 'bg-white', accent: 'bg-rose-50' },
    amber: { text: 'text-slate-900', icon: 'text-amber-700', border: 'border-slate-200', bg: 'bg-white', accent: 'bg-amber-50' },
    slate: { text: 'text-slate-900', icon: 'text-slate-700', border: 'border-slate-200', bg: 'bg-white', accent: 'bg-slate-50' },
  };
  const tone = tones[color] || tones.slate;

  return (
    <div className={`border ${tone.border} ${tone.bg} rounded-xl shadow-sm overflow-hidden`}>
      <div className={`h-10 ${tone.accent} border-b border-slate-100 flex items-center justify-between px-4`}>
        <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest">{title}</div>
        {Icon && (
          <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center">
            <Icon className={`w-4 h-4 ${tone.icon}`} />
          </div>
        )}
      </div>
      <div className="px-4 py-3">
        <div className={`text-2xl font-bold tracking-tight leading-none ${tone.text}`}>{value}</div>
        <div className="text-xs text-slate-500 mt-1.5 font-medium">{subtext}</div>
      </div>
    </div>
  );
}
