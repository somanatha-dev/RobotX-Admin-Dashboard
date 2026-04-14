import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Camera, Trash2 } from 'lucide-react';
import { useAppActions, useAppState } from '../context/appContext.js';
import * as robotsApi from '../lib/api/robots.js';

export default function RobotDetailPage() {
  const { robots } = useAppState();
  const { requestAuth, retire, addEvent } = useAppActions();
  const navigate = useNavigate();
  const { id } = useParams();

  const normalizeStatus = (s) => String(s || '').toUpperCase();
  const isActive = (s) => normalizeStatus(s) === 'ACTIVE';
  const isIdle = (s) => normalizeStatus(s) === 'IDLE';

  const robot = robots.find((r) => r.robotId === id);

  const sendCommand = (robotId, type) => {
    requestAuth(`${type} UNIT ${robotId}`, async () => {
      await robotsApi.sendCommand(robotId, type);
      addEvent(`Command ${type} sent to ${robotId}`, 'info');
    });
  };

  if (!robot && robots.length === 0) {
    return <div className="p-8 text-center font-bold text-slate-500">Loading unit…</div>;
  }

  if (!robot) {
    return (
      <div className="p-8 text-center font-bold text-slate-500">
        Robot Decommissioned or Not Found.
        <button onClick={() => navigate('/robots')} className="text-blue-500 underline ml-2">
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-50 overflow-y-auto">
      <div className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 py-3 lg:px-6 lg:py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/robots')}
            className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 transition-colors border border-transparent hover:border-slate-200"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold font-mono text-slate-900 tracking-tight">{robot.robotId}</h1>
              <span
                className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${
                  isActive(robot.status)
                    ? 'bg-emerald-100 text-emerald-700'
                    : isIdle(robot.status)
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-rose-100 text-rose-700'
                }`}
              >
                {normalizeStatus(robot.status)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex gap-2 sm:gap-3">
          <button
            onClick={() => sendCommand(robot.robotId, 'RESUME')}
            className="flex-1 sm:flex-none bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2.5 rounded-lg text-xs font-bold transition-colors shadow-sm"
          >
            RESUME
          </button>
          <button
            onClick={() => sendCommand(robot.robotId, 'RETURN')}
            className="flex-1 sm:flex-none bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2.5 rounded-lg text-xs font-bold transition-colors shadow-sm"
          >
            RETURN
          </button>
          <button
            onClick={() => sendCommand(robot.robotId, 'STOP')}
            className="flex-1 sm:flex-none bg-amber-500 hover:bg-amber-600 text-white px-6 py-2.5 rounded-lg text-xs font-bold tracking-widest transition-colors shadow-sm"
          >
            STOP
          </button>
          <div className="w-px h-8 bg-slate-300 mx-1 self-center hidden sm:block" />
          <button
            onClick={() => retire(robot.robotId)}
            className="flex-1 sm:flex-none bg-rose-600 hover:bg-rose-700 text-white px-4 py-2.5 rounded-lg text-xs font-bold transition-colors shadow-sm flex items-center justify-center gap-1.5"
            title="Permanently Remove Unit"
          >
            <Trash2 className="w-4 h-4" /> RETIRE
          </button>
        </div>
      </div>

      <div className="p-4 lg:p-6 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <span className="text-sm font-bold text-slate-800 uppercase tracking-widest flex items-center gap-2">
                <Camera className="w-4 h-4 text-slate-400" /> Primary Vision
              </span>
            </div>
            <div className="relative aspect-video bg-slate-900 flex items-center justify-center overflow-hidden">
              <div className="text-slate-400 text-sm font-semibold">No camera stream configured</div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Live State</h3>
            <div className="space-y-5">
              <div>
                <div className="flex justify-between items-end mb-2">
                  <span className="text-sm font-medium text-slate-600">Battery</span>
                  <span className="font-mono font-bold text-slate-900 text-lg">{Number(robot.battery || 0).toFixed(1)}%</span>
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                  <div
                    className={`h-full ${(Number(robot.battery) || 0) < 25 ? 'bg-rose-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Number(robot.battery || 0)}%` }}
                  />
                </div>
              </div>
              <div className="h-px bg-slate-100 w-full" />
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Current Speed</div>
                  <div className="font-mono text-2xl font-bold text-slate-900">
                    {robot.speed ?? '—'} {robot.speed == null ? null : <span className="text-sm text-slate-500 font-sans">m/s</span>}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Movement</div>
                  <div className="font-semibold text-slate-700 mt-1">{(Number(robot.speed) || 0) > 0 ? 'Moving' : 'Stationary'}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Unit Info</h3>
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3 text-sm shadow-sm">
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Online</span>
                <span className={`font-mono font-bold ${robot.isOnline ? 'text-emerald-600' : 'text-slate-500'}`}>{robot.isOnline ? 'YES' : 'NO'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Last Seen</span>
                <span className="font-mono font-bold text-slate-700">{robot.lastSeenAt ? new Date(robot.lastSeenAt).toLocaleString() : '—'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Location</span>
                <span className="font-mono font-bold text-slate-700">{robot.location?.name || '—'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Task</span>
                <span className="font-mono font-bold text-blue-600">{robot.currentTask?.taskId || 'None'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
