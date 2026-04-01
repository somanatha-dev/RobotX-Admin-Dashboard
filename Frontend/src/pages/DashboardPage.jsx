import React from 'react';
import { Activity, AlertTriangle, Battery, ListTodo, Play, ShieldCheck, X } from 'lucide-react';
import MetricCard from '../components/MetricCard.jsx';
import { useAppState } from '../context/appContext.js';

export default function DashboardPage() {
  const { robots, tasks, events } = useAppState();
  const online = robots.filter((r) => r.health.connection).length;
  const active = robots.filter((r) => r.status === 'active').length;
  const lowestBat = robots.length > 0 ? Math.min(...robots.map((r) => r.battery)) : 0;
  const lowBatCount = robots.filter((r) => r.battery < 25).length;
  const activeTasks = tasks.filter((t) => t.status === 'active').length;
  const failedTasks = tasks.filter((t) => t.status === 'failed').length;

  return (
    <div className="h-full p-5 lg:p-6 overflow-y-auto bg-slate-50">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">System Confidence</h1>
          <p className="text-xs text-slate-500 mt-1">Real-time overview of fleet health and operations.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <MetricCard icon={ShieldCheck} title="Online Robots" value={`${online}/${robots.length}`} subtext={`${robots.length - online} offline`} color="blue" />
          <MetricCard icon={Play} title="Active Robots" value={active} subtext="Working currently" color="emerald" />
          <MetricCard icon={Battery} title="Lowest Battery" value={`${lowestBat.toFixed(0)}%`} subtext="Requires charging" color={lowestBat < 20 ? 'rose' : 'amber'} />
          <MetricCard icon={AlertTriangle} title="< 25% Battery" value={lowBatCount} subtext="Low power units" color={lowBatCount > 0 ? 'amber' : 'slate'} />
          <MetricCard icon={ListTodo} title="Active Tasks" value={activeTasks} subtext="In progress" color="blue" />
          <MetricCard icon={X} title="Failed Tasks" value={failedTasks} subtext="Today" color={failedTasks > 0 ? 'rose' : 'slate'} />
        </div>

        <div>
          <h2 className="text-sm font-bold text-slate-900 mb-4 uppercase tracking-wider flex items-center gap-2">
            <Activity className="w-4 h-4 text-rose-500" /> Critical Events Feed
          </h2>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            {events.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-sm">System is stable. No critical events.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {events.map((ev) => (
                  <div key={ev.id} className="p-3.5 flex items-center justify-between hover:bg-slate-50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full shadow-sm ${ev.type === 'critical' ? 'bg-rose-500' : ev.type === 'warning' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                      <span className="text-sm font-medium text-slate-700">{ev.msg}</span>
                    </div>
                    <span className="text-xs font-mono text-slate-400 bg-slate-100 px-2 py-1 rounded">{ev.time}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
