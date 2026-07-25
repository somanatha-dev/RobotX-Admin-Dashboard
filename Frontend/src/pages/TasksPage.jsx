import React, { useMemo } from 'react';
import {
  Check,
  ListTodo,
  Loader2,
  MapPin,
  Navigation,
  Play,
  RefreshCw,
  Ruler,
  Timer,
  X,
} from 'lucide-react';

import MetricCard from '@/components/MetricCard.jsx';
import { useAppActions, useAppState } from '@/context/appContext.js';
import { Button } from '@/components/ui/button.jsx';
import { Badge } from '@/components/ui/badge.jsx';

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_ACTIVE = new Set(['PENDING', 'ASSIGNED', 'IN_PROGRESS']);

function normalizeStatus(s) {
  return String(s || '').toUpperCase();
}

function formatDistance(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return null;
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/** Remaining distance = total - travelled. Returns metres or null. */
function remainingMeters(distanceMeters, distanceTravelled) {
  const total = typeof distanceMeters === 'number' && Number.isFinite(distanceMeters) ? distanceMeters : null;
  const done  = typeof distanceTravelled === 'number' && Number.isFinite(distanceTravelled) ? distanceTravelled : 0;
  if (total === null) return null;
  return Math.max(0, total - done);
}

/**
 * ETA in minutes.
 * Uses remaining distance and live robot speed (m/s from telemetry).
 * Falls back to total distance if no progress data.
 */
function computeEta(task, robot) {
  const speed = typeof robot?.speed === 'number' && robot.speed > 0.05 ? robot.speed : null;
  if (!speed) return null;

  const total    = typeof task?.distanceMeters === 'number' ? task.distanceMeters : null;
  const travelled = typeof robot?.distanceTravelled === 'number' ? robot.distanceTravelled : 0;
  const rem = total !== null ? Math.max(0, total - travelled) : null;
  if (rem === null) return null;

  const seconds  = rem / speed;
  const minutes  = seconds / 60;
  if (minutes < 0.5) return '<1 min';
  return `~${Math.ceil(minutes)} min`;
}

/**
 * Extract the most meaningful label from a Mapbox place_name.
 * - "RNSIT MAIN LIBRARY, Civil..."         → "RNSIT MAIN LIBRARY"
 * - "108, 2, Uttarahalli Main Rd, ..."     → "Uttarahalli Main Rd"  (skips bare numbers)
 * - "Gate 1, RNSIT, Bengaluru..."          → "Gate 1, RNSIT"       (keeps short prefix)
 */
function formatPickupDrop(text) {
  if (!text) return '—';
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return text;

  // Skip leading parts that are pure numbers (house/plot numbers)
  let start = 0;
  while (start < parts.length - 1 && /^\d+$/.test(parts[start])) start++;

  const meaningful = parts[start];
  // If there's a short second component that adds context, append it
  const next = parts[start + 1];
  if (next && next.length <= 20 && !/^\d{5,}$/.test(next)) {
    return `${meaningful}, ${next}`;
  }
  return meaningful;
}

// ── Status badge styling ─────────────────────────────────────────────────────

function statusStyle(status) {
  const s = normalizeStatus(status);
  if (s === 'PENDING')     return 'bg-amber-100 text-amber-700 border-amber-200';
  if (s === 'ASSIGNED')    return 'bg-blue-100 text-blue-700 border-blue-200';
  if (s === 'IN_PROGRESS') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  if (s === 'COMPLETED')   return 'bg-slate-100 text-slate-600 border-slate-200';
  if (s === 'CANCELLED')   return 'bg-slate-100 text-slate-400 border-slate-200';
  return 'bg-rose-100 text-rose-700 border-rose-200'; // FAILED
}

// ── TaskCard ─────────────────────────────────────────────────────────────────

function TaskCard({ task, robot, onCancel }) {
  const status    = normalizeStatus(task.status);
  const isPending = status === 'PENDING';
  const isActive  = STATUS_ACTIVE.has(status);
  const canCancel = !['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);

  const taskId = task.taskId || task.id;
  const robotId = task.robot?.robotId || task.robotId || null;
  const dist = formatDistance(task.distanceMeters);
  const eta  = computeEta(task, robot);
  const rem  = remainingMeters(task.distanceMeters, robot?.distanceTravelled);

  return (
    <div className={`bg-white border rounded-2xl p-5 shadow-sm hover:shadow-md transition-all flex flex-col gap-4 ${
      isPending ? 'border-amber-200' : 'border-slate-200'
    }`}>
      {/* ── Header row ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono font-bold text-slate-900 text-sm tracking-tight">{taskId}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${statusStyle(status)}`}>
              {isPending ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : null}
              {status}
            </span>
          </div>
        </div>

        {/* Right side: loading spinner (PENDING) or robot ID */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          {isPending ? (
            <div className="flex items-center gap-1.5 text-amber-600 text-xs font-medium">
              <Loader2 className="w-4 h-4 animate-spin" />
              Computing…
            </div>
          ) : robotId ? (
            <div className="flex items-center gap-1.5">
              <Navigation className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-mono font-bold text-slate-900 text-sm">{robotId}</span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Unassigned</span>
          )}
        </div>
      </div>

      {/* ── Route ── */}
      <div className="bg-slate-50 rounded-xl px-4 py-3 border border-slate-100 space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <span className="font-medium text-slate-700 truncate">{formatPickupDrop(task.pickup)}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="w-3.5 h-3.5 text-rose-500 shrink-0" />
          <span className="font-medium text-slate-700 truncate">{formatPickupDrop(task.drop)}</span>
        </div>
      </div>

      {/* ── Metrics row: Distance + ETA ── */}
      {!isPending && (
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-slate-50 rounded-xl px-3 py-2.5 border border-slate-100 flex items-center gap-2">
            <Ruler className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Distance</div>
              <div className="text-sm font-bold text-slate-900 font-mono">{dist ?? '—'}</div>
              {rem !== null && rem < (task.distanceMeters ?? Infinity) && (
                <div className="text-[10px] text-muted-foreground">
                  {formatDistance(rem)} left
                </div>
              )}
            </div>
          </div>
          <div className="bg-slate-50 rounded-xl px-3 py-2.5 border border-slate-100 flex items-center gap-2">
            <Timer className="w-3.5 h-3.5 text-purple-500 shrink-0" />
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">ETA</div>
              <div className={`text-sm font-bold font-mono ${eta ? 'text-slate-900' : 'text-muted-foreground'}`}>
                {eta ?? (robot?.status === 'CHARGING' ? 'Charging…' : robot && isActive ? 'Idle…' : '—')}
              </div>
              {robot?.speed > 0.05 && (
                <div className="text-[10px] text-muted-foreground">
                  {robot.speed.toFixed(1)} m/s
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Action ── */}
      {canCancel ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onCancel(taskId)}
          className="w-full text-destructive hover:bg-destructive/10 border border-destructive/20"
        >
          Cancel Task
        </Button>
      ) : (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-1">
          {status === 'COMPLETED' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : null}
          {status === 'CANCELLED' ? <X className="w-3.5 h-3.5" /> : null}
          {status === 'FAILED' ? <RefreshCw className="w-3.5 h-3.5 text-rose-500" /> : null}
          {status}
        </div>
      )}
    </div>
  );
}

// ── TasksPage ─────────────────────────────────────────────────────────────────

export default function TasksPage() {
  const { tasks, robots } = useAppState();
  const { setIsCreatingTask, cancelTask } = useAppActions();

  const totalTasks     = tasks.length;
  const activeTasks    = tasks.filter((t) => STATUS_ACTIVE.has(normalizeStatus(t.status))).length;
  const completedTasks = tasks.filter((t) => normalizeStatus(t.status) === 'COMPLETED').length;
  const failedTasks    = tasks.filter((t) => normalizeStatus(t.status) === 'FAILED').length;

  // Build robotId → robot map for live speed/distanceTravelled lookup.
  const robotMap = useMemo(() => {
    const m = new Map();
    for (const r of robots) {
      if (r.robotId) m.set(String(r.robotId), r);
    }
    return m;
  }, [robots]);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-lg font-medium">Task Control</h1>
          <p className="text-sm text-muted-foreground mt-1">Assign and monitor fleet objectives.</p>
        </div>
        <Button onClick={() => setIsCreatingTask(true)} className="whitespace-nowrap">
          + CREATE TASK
        </Button>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={ListTodo} title="Total Tasks"  value={totalTasks}     subtext="in system" />
        <MetricCard icon={Play}     title="Active"       value={activeTasks}    subtext="in progress" />
        <MetricCard icon={Check}    title="Completed"    value={completedTasks} subtext="done" />
        <MetricCard icon={X}        title="Failed"       value={failedTasks}    subtext="needs review" />
      </div>

      {/* Task cards grid */}
      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
          <ListTodo className="w-10 h-10 opacity-20" />
          <div className="text-sm">No tasks yet. Create one to get started.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {tasks.map((t) => {
            const taskId  = t.taskId || t.id;
            const robotId = t.robot?.robotId || t.robotId || null;
            const robot   = robotId ? robotMap.get(robotId) : null;
            return (
              <TaskCard
                key={taskId}
                task={t}
                robot={robot}
                onCancel={cancelTask}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
