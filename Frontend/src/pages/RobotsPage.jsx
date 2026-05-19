import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  BatteryCharging,
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
import * as robotsApi from '../lib/api/robots.js';

function formatLocationName(name) {
  if (!name) return '—';
  const first = name.split(',')[0].trim();
  return first || name;
}

function batteryColors(pct) {
  if (pct >= 75) return { bar: 'bg-emerald-500', text: 'text-emerald-700', track: 'bg-emerald-100' };
  if (pct >= 25) return { bar: 'bg-amber-400',   text: 'text-amber-600',   track: 'bg-amber-100' };
  return              { bar: 'bg-rose-500',    text: 'text-rose-600',    track: 'bg-rose-100' };
}

export default function RobotsPage() {
  const { robots } = useAppState();
  const { requestAuth, retire, addEvent } = useAppActions();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('All');
  const [selectedRobot, setSelectedRobot] = useState(null);
  const [search, setSearch] = useState('');

  const normalizeStatus = (s) => String(s || '').toUpperCase();
  const isIssues = (s) => ['ERROR', 'ISSUES', 'OFFLINE'].includes(normalizeStatus(s));
  const isActive = (s) => normalizeStatus(s) === 'ACTIVE';
  const isIdle = (s) => normalizeStatus(s) === 'IDLE';
  const isCharging = (s) => ['CHARGING', 'PAUSED'].includes(normalizeStatus(s));

  const filteredRobots = robots.filter((r) => {
    const q = String(search || '').trim().toLowerCase();
    if (q) {
      const id = String(r.robotId || '').toLowerCase();
      const nm = String(r.name || '').toLowerCase();
      if (!id.includes(q) && !nm.includes(q)) return false;
    }

    if (filter === 'Active') return isActive(r.status);
    if (filter === 'Idle') return isIdle(r.status);
    if (filter === 'Issues') return isIssues(r.status);
    if (filter === 'Low Battery') return (Number(r.battery) || 0) > 0 && Number(r.battery) < 25;
    return true;
  });

  const sendCommand = (robotId, type) => {
    requestAuth(`${type} UNIT ${robotId}`, async () => {
      await robotsApi.sendCommand(robotId, type);
      addEvent(`Command ${type} sent to ${robotId}`, 'info');
    });
  };

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
              placeholder="Search ID or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-5 max-w-7xl mx-auto">
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
                  charging: {
                    text: 'text-sky-700',
                    border: 'border-sky-100',
                    bg: 'bg-gradient-to-br from-sky-100/60 via-sky-50 to-white',
                    watermark: BatteryCharging,
                  },
                  issues: {
                    text: 'text-rose-700',
                    border: 'border-rose-100',
                    bg: 'bg-gradient-to-br from-rose-100/60 via-rose-50 to-white',
                    watermark: AlertTriangle,
                  },
                };
                const statusKey = isActive(r.status)
                  ? 'active'
                  : isCharging(r.status)
                    ? 'charging'
                    : isIssues(r.status)
                      ? 'issues'
                      : 'idle';
                const cardTone = tones[statusKey] || {
                  text: 'text-blue-700',
                  border: 'border-blue-100',
                  bg: 'bg-gradient-to-br from-blue-100/60 via-blue-50 to-white',
                  watermark: MapPin,
                };
                const CardWatermark = cardTone.watermark;
                const battery = Number(r.battery || 0);
                const bc = batteryColors(battery);

                return (
                  <div
                    key={r.robotId}
                    className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col shadow-sm hover:shadow-md transition-all group relative overflow-hidden min-h-50"
                  >
                    <CardWatermark className={`absolute -right-8 -bottom-8 w-28 h-28 ${cardTone.text} opacity-[0.05]`} aria-hidden="true" />

                    {/* Header */}
                    <div className="flex justify-between items-start mb-4">
                      <div className="min-w-0 flex-1 pr-3">
                        {r.name ? (
                          <div className="text-xs font-medium text-slate-500 mb-0.5 truncate">{r.name}</div>
                        ) : null}
                        <div className="font-mono font-bold text-slate-900 text-lg flex items-center gap-2">
                          {r.robotId}
                          <div
                            className={`w-2 h-2 rounded-full shrink-0 ${r.isOnline ? 'bg-emerald-500' : 'bg-slate-400'}`}
                          />
                        </div>
                        <div className="text-xs text-slate-500 font-medium mt-0.5 uppercase tracking-wide">
                          {normalizeStatus(r.status)}
                        </div>
                      </div>

                      {/* Battery */}
                      <div className="text-right shrink-0">
                        <div className={`font-mono font-bold text-sm ${bc.text}`}>
                          {battery.toFixed(0)}%
                        </div>
                        <div className={`w-14 h-2 ${bc.track} rounded-full overflow-hidden mt-1.5 ml-auto`}>
                          <div
                            className={`h-full ${bc.bar} rounded-full transition-all duration-700`}
                            style={{ width: `${Math.max(3, battery)}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Info */}
                    <div className="bg-white/70 rounded-xl p-3.5 text-sm border border-slate-200/60 mb-4 flex-1 space-y-2.5">
                      <div className="flex justify-between items-start gap-2">
                        <span className="text-slate-500 text-xs shrink-0">Task</span>
                        <span className="font-mono font-medium text-slate-900 text-right">
                          {r.currentTask?.taskId || 'None'}
                        </span>
                      </div>
                      <div className="flex justify-between items-start gap-2">
                        <span className="text-slate-500 text-xs shrink-0">Location</span>
                        <span className="font-medium text-slate-700 text-right text-xs max-w-[65%] leading-snug">
                          {formatLocationName(r.location?.name)}
                        </span>
                      </div>
                    </div>

                    {/* Actions — no delete in card */}
                    <div className="mt-auto flex gap-2">
                      <button
                        onClick={() => setSelectedRobot(r)}
                        className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs py-2.5 rounded-xl font-semibold transition-colors shadow-sm"
                      >
                        Control
                      </button>
                      <button
                        onClick={() => navigate(`/robots/${r.robotId}`)}
                        className="flex-1 bg-slate-900 hover:bg-slate-800 text-white text-xs py-2.5 rounded-xl font-semibold transition-colors shadow-sm"
                      >
                        Inspect
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
                <div className="flex items-center gap-3 min-w-0">
                  <div>
                    {selectedRobot.name ? (
                      <div className="text-xs text-slate-500 font-medium">{selectedRobot.name}</div>
                    ) : null}
                    <div className="font-mono text-xl font-bold text-slate-900">{selectedRobot.robotId}</div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 ${
                      isActive(selectedRobot.status)
                        ? 'bg-emerald-100 text-emerald-700'
                        : isCharging(selectedRobot.status)
                          ? 'bg-sky-100 text-sky-700'
                          : isIdle(selectedRobot.status)
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-rose-100 text-rose-700'
                    }`}
                  >
                    {normalizeStatus(selectedRobot.status)}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedRobot(null)}
                  className="p-1.5 hover:bg-slate-200 rounded-md text-slate-500 transition-colors shrink-0 ml-2"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-6">
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => sendCommand(selectedRobot.robotId, 'STOP')}
                    className="bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <StopCircle className="w-5 h-5" /> STOP
                  </button>
                  <button
                    onClick={() => sendCommand(selectedRobot.robotId, 'PAUSE')}
                    className="bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <Pause className="w-5 h-5" /> PAUSE
                  </button>
                  <button
                    onClick={() => sendCommand(selectedRobot.robotId, 'RETURN')}
                    className="bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <RefreshCw className="w-5 h-5" /> RETURN
                  </button>
                </div>

                <button
                  onClick={() => {
                    retire(selectedRobot.robotId);
                    setSelectedRobot(null);
                  }}
                  className="w-full bg-rose-600 hover:bg-rose-700 text-white py-2.5 rounded-xl font-bold transition-colors shadow-sm flex items-center justify-center gap-2 text-sm"
                  title="Permanently Remove Unit"
                >
                  <Trash2 className="w-4 h-4" /> Retire Unit
                </button>

                <div className="h-px bg-slate-100 w-full" />

                <div>
                  <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Live State</h3>
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3 text-sm shadow-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Battery</span>
                      <div className="flex items-center gap-3">
                        <div className="w-24 h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${batteryColors(Number(selectedRobot.battery || 0)).bar}`}
                            style={{ width: `${Number(selectedRobot.battery || 0)}%` }}
                          />
                        </div>
                        <span className={`font-mono font-bold w-9 text-right ${batteryColors(Number(selectedRobot.battery || 0)).text}`}>
                          {Number(selectedRobot.battery || 0).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Speed</span>
                      <span className="font-mono font-bold text-slate-700">
                        {selectedRobot.speed ?? '—'}{selectedRobot.speed == null ? '' : ' m/s'}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Task</span>
                      <span className="font-mono font-bold text-blue-600">
                        {selectedRobot.currentTask?.taskId || 'None'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
