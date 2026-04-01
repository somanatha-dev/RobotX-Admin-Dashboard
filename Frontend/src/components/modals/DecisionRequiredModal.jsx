import React from 'react';
import { AlertTriangle } from 'lucide-react';

export default function DecisionRequiredModal({
  decisionRequest,
  onWait,
  onReroute,
  onCancel,
}) {
  if (!decisionRequest) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md relative z-10 overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-200">
        <div className="bg-amber-50 border-b border-amber-100 p-4 flex justify-between items-center">
          <div className="flex items-center gap-2 text-amber-700">
            <AlertTriangle className="w-5 h-5" />
            <h2 className="font-bold tracking-wide">DECISION REQUIRED</h2>
          </div>
          <div className="text-xl font-mono font-bold text-amber-600 bg-white px-2 py-1 rounded shadow-sm">
            00:{decisionRequest.countdown.toString().padStart(2, '0')}
          </div>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4 text-sm bg-slate-50 p-3 rounded-lg border border-slate-100">
            <div>
              <span className="text-slate-500 block text-xs uppercase mb-0.5">Robot ID</span>
              <span className="font-mono font-bold text-slate-900">{decisionRequest.robotId}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-xs uppercase mb-0.5">Task ID</span>
              <span className="font-mono font-bold text-slate-900">{decisionRequest.taskId}</span>
            </div>
          </div>

          <div>
            <span className="text-slate-700 font-semibold block mb-2 text-sm">{decisionRequest.issue}</span>
            <div className="relative h-40 bg-slate-900 rounded-lg overflow-hidden group border border-slate-200 shadow-inner">
              <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&q=80&w=800')] bg-cover bg-center opacity-80 mix-blend-luminosity"></div>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onWait}
              className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 py-2.5 rounded-lg text-sm font-semibold transition-colors shadow-sm"
            >
              WAIT
            </button>
            <button
              type="button"
              onClick={onReroute}
              className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-lg text-sm font-semibold transition-colors shadow-sm"
            >
              REROUTE
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 bg-slate-900 hover:bg-slate-800 text-white py-2.5 rounded-lg text-sm font-semibold transition-colors shadow-sm"
            >
              CANCEL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
