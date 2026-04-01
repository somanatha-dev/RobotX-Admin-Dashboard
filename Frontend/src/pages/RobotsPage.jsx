import React, { useState } from 'react';
import {
  AlertTriangle,
  Battery,
  MapPin,
  Pause,
  RefreshCw,
  Search,
  ShieldCheck,
  StopCircle,
  Trash2,
  X,
} from 'lucide-react';

import { useAppActions, useAppState } from '../context/appContext.js';

export default function RobotsPage() {
  const { robots } = useAppState();
  const { navigate, requestAuth, retire } = useAppActions();
  const [filter, setFilter] = useState('All');
  const [selectedRobot, setSelectedRobot] = useState(null);

  const filteredRobots = robots.filter((r) => {
    if (filter === 'Active') return r.status === 'active';
    if (filter === 'Idle') return r.status === 'idle';
    if (filter === 'Issues') return r.status === 'issues' || r.status === 'error';
    if (filter === 'Low Battery') return r.battery < 25;
    return true;
  });

  return (
    <div className="h-full flex flex-col relative bg-slate-100/50">
      <style>{`
        .robot-marker-root { width: 34px; height: 34px; pointer-events: auto; }
        .robot-car { width: 34px; height: 34px; display: grid; place-items: center; transform-origin: 50% 50%; will-change: transform; }
      `}</style>
      <div className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-4 flex-1">
          <div className="relative w-48 lg:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search ID..."
              className="w-full bg-slate-50 border border-slate-200 rounded-lg py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-slate-900"
            />
          </div>
        </div>

        <div className="hidden md:flex items-center gap-2">
          {['All', 'Active', 'Idle', 'Issues', 'Low Battery'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-all ${
                filter === f
                  ? 'bg-slate-900 border-slate-900 text-white shadow-sm'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden flex">
        <div className="flex-1 p-6 overflow-y-auto bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-w-7xl mx-auto">
            {filteredRobots.map((r) =>
              (() => {
                const tones = {
                  active: {
                    text: 'text-emerald-700',
                    border: 'border-emerald-100',
                    bg: 'bg-gradient-to-br from-emerald-100/60 via-emerald-50 to-white',
                    watermark: ShieldCheck,
                  },
                  idle: {
                    text: 'text-amber-700',
                    border: 'border-amber-100',
                    bg: 'bg-gradient-to-br from-amber-100/60 via-amber-50 to-white',
                    watermark: Pause,
                  },
                  issues: {
                    text: 'text-rose-700',
                    border: 'border-rose-100',
                    bg: 'bg-gradient-to-br from-rose-100/60 via-rose-50 to-white',
                    watermark: AlertTriangle,
                  },
                };
                const tone = tones[r.status] || {
                  text: 'text-blue-700',
                  border: 'border-blue-100',
                  bg: 'bg-gradient-to-br from-blue-100/60 via-blue-50 to-white',
                  watermark: MapPin,
                };
                const Watermark = tone.watermark;

                return (
                  <div
                    key={r.id}
                    className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col shadow-sm hover:shadow-md transition-all group relative overflow-hidden"
                  >
                    <Watermark className={`absolute -right-8 -bottom-8 w-28 h-28 ${tone.text} opacity-[0.05]`} aria-hidden="true" />
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <div className="font-mono font-bold text-slate-900 text-lg flex items-center gap-2">
                          {r.id}
                          <div
                            className={`w-2 h-2 rounded-full ${
                              r.status === 'active'
                                ? 'bg-emerald-500'
                                : r.status === 'issues'
                                  ? 'bg-rose-500'
                                  : 'bg-amber-500'
                            }`}
                          />
                        </div>
                        <div className="text-xs text-slate-500 font-medium mt-1 uppercase tracking-wide">{r.status}</div>
                      </div>
                      <div className="text-right">
                        <div className={`font-mono font-bold text-sm ${r.battery < 25 ? 'text-rose-600' : 'text-slate-700'}`}>{r.battery.toFixed(0)}%</div>
                        <Battery className={`w-4 h-4 ml-auto mt-1 ${r.battery < 25 ? 'text-rose-500' : 'text-slate-400'}`} />
                      </div>
                    </div>

                    <div className="bg-white/70 rounded-xl p-3 text-sm border border-slate-200/60 mb-4 flex-1">
                      <div className="flex justify-between mb-2">
                        <span className="text-slate-500 text-xs">Task</span>
                        <span className="font-mono font-medium text-slate-900">{r.task || 'None'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500 text-xs">Location</span>
                        <span className="font-medium text-slate-700">{r.locText}</span>
                      </div>
                    </div>

                    {r.issue && (
                      <div className="text-xs text-rose-700 mb-4 flex items-center gap-1.5 bg-rose-50 px-2 py-1.5 rounded-md font-medium border border-rose-100">
                        <AlertTriangle className="w-3.5 h-3.5" /> {r.issue}
                      </div>
                    )}

                    <div className="mt-auto flex gap-2">
                      <button
                        onClick={() => setSelectedRobot(r)}
                        className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs py-2 rounded-lg font-semibold transition-colors shadow-sm"
                      >
                        Control
                      </button>
                      <button
                        onClick={() => navigate('/robots/:id', r.id)}
                        className="flex-1 bg-slate-900 hover:bg-slate-800 text-white text-xs py-2 rounded-lg font-semibold transition-colors shadow-sm"
                      >
                        Inspect
                      </button>
                      <button
                        onClick={() => retire(r.id)}
                        className="bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-700 px-3 rounded-lg text-xs font-bold transition-colors shadow-sm"
                        title="Permanently Remove Unit"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        </div>

        {/* RIGHT SIDE PANEL */}
        {selectedRobot && (
          <div
            className="absolute inset-0 bg-slate-900/10 backdrop-blur-[1px] z-20 md:hidden"
            onClick={() => setSelectedRobot(null)}
          />
        )}

        <div
          className={`absolute top-0 right-0 bottom-0 w-full md:w-96 bg-white border-l border-slate-200 shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col z-30 ${
            selectedRobot ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          {selectedRobot && (
            <>
              <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
                <div className="flex items-center gap-3">
                  <div className="font-mono text-xl font-bold text-slate-900">{selectedRobot.id}</div>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      ['active', 'delivering'].includes(String(selectedRobot.status).toLowerCase())
                        ? 'bg-emerald-100 text-emerald-700'
                        : ['idle', 'to_pickup'].includes(String(selectedRobot.status).toLowerCase())
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-rose-100 text-rose-700'
                    }`}
                  >
                    {selectedRobot.status}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedRobot(null)}
                  className="p-1.5 hover:bg-slate-200 rounded-md text-slate-500 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-6">
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => requestAuth(`STOP UNIT ${selectedRobot.id}`, () => {})}
                    className="bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <StopCircle className="w-5 h-5" /> STOP
                  </button>
                  <button
                    onClick={() => requestAuth(`PAUSE UNIT ${selectedRobot.id}`, () => {})}
                    className="bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <Pause className="w-5 h-5" /> PAUSE
                  </button>
                  <button
                    onClick={() => requestAuth(`RETURN UNIT ${selectedRobot.id}`, () => {})}
                    className="bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <RefreshCw className="w-5 h-5" /> RETURN
                  </button>
                </div>

                {selectedRobot?.id?.startsWith('RBT-') && (
                  <button
                    onClick={() => {
                      retire(selectedRobot.id);
                      setSelectedRobot(null);
                    }}
                    className="w-full bg-rose-600 hover:bg-rose-700 text-white py-2.5 rounded-xl font-bold transition-colors shadow-sm flex items-center justify-center gap-2 text-sm"
                    title="Permanently Remove Unit"
                  >
                    <Trash2 className="w-4 h-4" /> Retire Unit
                  </button>
                )}

                <div className="h-px bg-slate-100 w-full" />

                <div>
                  <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Live State</h3>
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3 text-sm shadow-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Battery</span>
                      <div className="flex items-center gap-3">
                        <div className="w-24 h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${selectedRobot.battery < 25 ? 'bg-rose-500' : 'bg-emerald-500'}`}
                            style={{ width: `${selectedRobot.battery}%` }}
                          />
                        </div>
                        <span className="font-mono font-bold w-9 text-right text-slate-700">{selectedRobot.battery.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Speed</span>
                      <span className="font-mono font-bold text-slate-700">{selectedRobot.speed} m/s</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Task</span>
                      <span className="font-mono font-bold text-blue-600">{selectedRobot.task || 'None'}</span>
                    </div>
                  </div>
                </div>

                {selectedRobot.issue && (
                  <div>
                    <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Warnings</h3>
                    <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-start gap-2 text-sm text-rose-700 font-medium">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{selectedRobot.issue}</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
