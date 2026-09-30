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
import { TaskRejectionPanel, useTaskRejection } from '@/features/tasks/taskRejection.js';
import { taskPhase } from '@/features/tasks/taskLifecycle.js';
import { plannedRouteMeters } from '@/features/tasks/taskRoute.js';
import { cancellationFor } from '@/lib/taskCancellation.js';

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

// Below this the robot is reported as stationary. The same threshold the card has always used.
const MOVING_SPEED_MS = 0.05;

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

// ── Phase badge styling ──────────────────────────────────────────────────────

// Keyed by `taskPhase().tone`. An unknown status is neutral, never styled as a failure.
const TONE_STYLE = Object.freeze({
  pending: 'bg-amber-100 text-amber-700 border-amber-200',
  warning: 'bg-orange-100 text-orange-800 border-orange-200',
  active: 'bg-blue-100 text-blue-700 border-blue-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  muted: 'bg-slate-100 text-slate-400 border-slate-200',
  error: 'bg-rose-100 text-rose-700 border-rose-200',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
});

// ── TaskCard ─────────────────────────────────────────────────────────────────

function TaskCard({ task, robot, route, assignmentSignal, onCancel }) {
  const status    = normalizeStatus(task.status);
  const isPending = status === 'PENDING';
  // The engine's latest round for this task, polled only while it is PENDING. One poll,
  // shared by the header (FE-06) and the "why not assigned" panel.
  const rejection = useTaskRejection(task.taskId || task.id, { enabled: isPending, refreshKey: assignmentSignal });
  // What the card may truthfully say about where the task is (FE-05) — see taskLifecycle.js.
  const phase = taskPhase({ status, rejection, verification: task.verification });
  const isExecuting = phase.key === 'EXECUTING';
  // Whether a cancel control is shown, and whether it can succeed. For an engine-managed
  // task it cannot: the backend answers 409 and changes nothing (see taskCancellation.js).
  const cancellation = cancellationFor(task);

  const taskId = task.taskId || task.id;
  const robotId = task.robot?.robotId || task.robotId || null;
  // FE-07: `Task.distanceMeters` when the backend sets it; otherwise the length of the route
  // the engine actually offered the robot (TASK_ASSIGNED). No ETA is derived — see taskRoute.js.
  const routeMeters = typeof task.distanceMeters === 'number' ? task.distanceMeters : plannedRouteMeters(route);
  const dist = formatDistance(routeMeters);
  const speed = typeof robot?.speed === 'number' && Number.isFinite(robot.speed) ? robot.speed : null;

  return (
    <div className={`bg-white border rounded-2xl p-5 shadow-sm hover:shadow-md transition-all flex flex-col gap-4 ${
      phase.tone === 'pending' || phase.tone === 'warning' ? 'border-amber-200' : 'border-slate-200'
    }`} data-task-phase={phase.key}>
      {/* ── Header row ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono font-bold text-slate-900 text-sm tracking-tight">{taskId}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${TONE_STYLE[phase.tone] || TONE_STYLE.neutral}`}>
              {phase.busy ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : null}
              {phase.label}
            </span>
          </div>
          {phase.detail ? (
            <div className="mt-1 text-[11px] text-muted-foreground" data-task-phase-detail>{phase.detail}</div>
          ) : null}
        </div>

        {/* Right side: the robot once one is assigned; a spinner only while assignment is
            genuinely still being worked on — never beside "no feasible robot". */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          {robotId && !isPending ? (
            <div className="flex items-center gap-1.5">
              <Navigation className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-mono font-bold text-slate-900 text-sm">{robotId}</span>
            </div>
          ) : phase.busy ? (
            <div className="flex items-center gap-1.5 text-amber-600 text-xs font-medium">
              <Loader2 className="w-4 h-4 animate-spin" />
              Computing…
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">No robot assigned</span>
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

      {/* ── Why not assigned (PENDING only; explanation, never the task's authority) ── */}
      <TaskRejectionPanel taskId={taskId} status={status} state={rejection} />

      {/* ── Metrics row: Distance + ETA ── */}
      {!isPending && (
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-slate-50 rounded-xl px-3 py-2.5 border border-slate-100 flex items-center gap-2">
            <Ruler className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Distance</div>
              <div className={`text-sm font-bold font-mono ${dist ? 'text-slate-900' : 'text-muted-foreground'}`} data-task-distance>
                {dist ?? (isExecuting ? 'Unavailable' : '—')}
              </div>
              {dist && typeof task.distanceMeters !== 'number' ? (
                <div className="text-[10px] text-muted-foreground">planned route</div>
              ) : null}
            </div>
          </div>
          <div className="bg-slate-50 rounded-xl px-3 py-2.5 border border-slate-100 flex items-center gap-2">
            <Timer className="w-3.5 h-3.5 text-purple-500 shrink-0" />
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">ETA</div>
              {/* The engine publishes no ETA, so none is shown — and never "Idle…" for a task
                  that is executing. The robot's live motion is shown instead, as reported. */}
              <div className="text-sm font-bold font-mono text-muted-foreground" data-task-eta>
                {isExecuting ? 'Not provided' : '—'}
              </div>
              {isExecuting && speed !== null ? (
                <div className="text-[10px] text-muted-foreground" data-robot-motion>
                  {speed > MOVING_SPEED_MS ? `Robot moving · ${speed.toFixed(1)} m/s` : 'Robot stationary'}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ── Action ── */}
      {cancellation.show && cancellation.available ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onCancel(taskId)}
          className="w-full text-destructive hover:bg-destructive/10 border border-destructive/20"
        >
          Cancel Task
        </Button>
      ) : cancellation.show ? (
        <div className="space-y-1" data-cancel-state="unavailable">
          <Button
            variant="ghost"
            size="sm"
            disabled
            aria-disabled="true"
            title={cancellation.reason}
            className="w-full border border-slate-200 text-slate-400 cursor-not-allowed"
          >
            Cancel unavailable
          </Button>
          <div className="text-[11px] text-muted-foreground">{cancellation.reason}</div>
        </div>
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
  const { tasks, robots, taskRoutes, assignmentSignal } = useAppState();
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
                route={taskRoutes?.[taskId] || null}
                assignmentSignal={assignmentSignal}
                onCancel={cancelTask}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
