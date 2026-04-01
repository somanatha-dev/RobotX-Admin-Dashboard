import React, { useState } from 'react';
import { ListTodo, X } from 'lucide-react';

export default function CreateTaskModal({ robots, onClose, onCreate }) {
  const [form, setForm] = useState({
    pickup: 'Zone A',
    drop: 'Zone D',
  });

  const pickAutoRobotId = () => {
    const pool = Array.isArray(robots) ? robots : [];
    const preferred = pool.find((r) => r.status === 'idle') || pool.find((r) => r.status === 'active') || pool[0];
    return preferred?.id || 'RBT-1000';
  };

  const makeTaskId = () => {
    const base = 8000;
    const rand = Math.floor(Math.random() * 900) + 100;
    return `TSK-${base + rand}`;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const now = new Date().toISOString();
    const robotId = pickAutoRobotId();
    const task = {
      id: makeTaskId(),
      robotId,
      status: 'active',
      pickup: form.pickup,
      drop: form.drop,
      time: now,
      timeline: [
        { state: 'Created', time: 'Just now', done: true },
        { state: 'Assigned', time: 'Just now', done: true },
        { state: 'Started', time: '--', done: false },
        { state: 'In Progress', time: '--', done: false },
      ],
    };
    onCreate(task);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md relative z-10 overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-200">
        <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <div className="flex items-center gap-2 text-slate-900">
            <ListTodo className="w-5 h-5 text-blue-600" />
            <h2 className="font-bold tracking-wide text-lg">Create Task</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Assignment</div>
            <div className="mt-2 text-sm text-slate-700 font-medium">Robot is auto-assigned based on availability.</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Pickup</label>
              <input
                value={form.pickup}
                onChange={(e) => setForm((prev) => ({ ...prev, pickup: e.target.value }))}
                className="w-full bg-white border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Drop</label>
              <input
                value={form.drop}
                onChange={(e) => setForm((prev) => ({ ...prev, drop: e.target.value }))}
                className="w-full bg-white border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 py-2.5 rounded-lg text-sm font-bold transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 bg-slate-900 hover:bg-slate-800 text-white py-2.5 rounded-lg text-sm font-bold transition-colors shadow-sm"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
