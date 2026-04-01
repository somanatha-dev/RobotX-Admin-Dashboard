import React from 'react';
import { Check, X } from 'lucide-react';

export default function HealthRow({ label, status }) {
  return (
    <div className="flex justify-between items-center py-1">
      <span className="text-sm font-medium text-slate-600">{label}</span>
      {status ? (
        <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-md">
          <Check className="w-3.5 h-3.5" /> OK
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-xs font-bold text-rose-700 bg-rose-50 border border-rose-100 px-2.5 py-1 rounded-md">
          <X className="w-3.5 h-3.5" /> FAIL
        </span>
      )}
    </div>
  );
}
