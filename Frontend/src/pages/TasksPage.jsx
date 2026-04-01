import React from 'react';
import { Check, ListTodo, Play, X } from 'lucide-react';
import MetricCard from '../components/MetricCard.jsx';
import { useAppActions, useAppState } from '../context/appContext.js';

export default function TasksPage() {
  const { tasks, robots } = useAppState();
  const { setIsCreatingTask, cancelTask } = useAppActions();
  const totalTasks = tasks.length;
  const activeTasks = tasks.filter((t) => t.status === 'active').length;
  const completedTasks = tasks.filter((t) => t.status === 'completed').length;
  const failedTasks = tasks.filter((t) => t.status === 'failed').length;

  const statusPill = (status) => {
    if (status === 'active') return 'bg-blue-100 text-blue-700';
    if (status === 'completed') return 'bg-emerald-100 text-emerald-700';
    return 'bg-rose-100 text-rose-700';
  };

  return (
    <div className="h-full p-6 lg:p-8 overflow-y-auto bg-slate-50">
      <div className="flex justify-between items-end mb-6 max-w-6xl mx-auto">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Task Control</h1>
          <p className="text-sm text-slate-500 mt-1">Assign and monitor fleet objectives.</p>
        </div>
        <button
          onClick={() => setIsCreatingTask(true)}
          className="bg-slate-900 hover:bg-slate-800 text-white px-5 py-2.5 rounded-lg text-sm font-bold transition-colors shadow-sm whitespace-nowrap"
        >
          + CREATE TASK
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-6xl mx-auto">
        <MetricCard icon={ListTodo} title="Total Tasks" value={totalTasks} subtext="in system" color="slate" />
        <MetricCard icon={Play} title="Active" value={activeTasks} subtext="in progress" color="blue" />
        <MetricCard icon={Check} title="Completed" value={completedTasks} subtext="done" color="emerald" />
        <MetricCard icon={X} title="Failed" value={failedTasks} subtext="needs review" color={failedTasks > 0 ? 'rose' : 'slate'} />
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-x-auto shadow-sm max-w-6xl mx-auto mt-6">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <div className="text-sm font-bold text-slate-900">Task List</div>
          <div className="text-xs text-slate-500 font-mono">{robots.length} robots</div>
        </div>
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-white border-b border-slate-100 text-slate-500 font-semibold text-xs uppercase tracking-wider">
            <tr>
              <th className="px-6 py-4">Task ID</th>
              <th className="px-6 py-4">Robot</th>
              <th className="px-6 py-4">Route</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tasks.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-6 py-4 font-mono font-bold text-slate-900">{t.id}</td>
                <td className="px-6 py-4 font-mono text-slate-600">{t.robotId}</td>
                <td className="px-6 py-4 text-slate-700 font-medium">
                  {t.pickup} → {t.drop}
                </td>
                <td className="px-6 py-4">
                  <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase ${statusPill(t.status)}`}>{t.status}</span>
                </td>
                <td className="px-6 py-4 text-right">
                  {t.status === 'active' ? (
                    <button onClick={() => cancelTask(t.id)} className="text-rose-600 text-xs font-bold hover:underline">
                      Cancel
                    </button>
                  ) : (
                    <span className="text-xs text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
