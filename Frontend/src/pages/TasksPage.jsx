import React from 'react';
import { Check, ListTodo, Play, X } from 'lucide-react';
import MetricCard from '../components/MetricCard.jsx';
import { useAppActions, useAppState } from '../context/appContext.js';
import { Button } from '../components/ui/button.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Card } from '../components/ui/card.jsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.jsx';

export default function TasksPage() {
  const { tasks, robots } = useAppState();
  const { setIsCreatingTask, cancelTask } = useAppActions();
  const normalizeStatus = (s) => String(s || '').toUpperCase();
  const totalTasks = tasks.length;
  const activeTasks = tasks.filter((t) => ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(normalizeStatus(t.status))).length;
  const completedTasks = tasks.filter((t) => normalizeStatus(t.status) === 'COMPLETED').length;
  const failedTasks = tasks.filter((t) => normalizeStatus(t.status) === 'FAILED').length;

  const canCancel = (status) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(normalizeStatus(status));

  const statusBadge = (status) => {
    const s = normalizeStatus(status);
    if (['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(s)) {
      return { variant: 'default', className: 'bg-primary text-primary-foreground border-transparent' };
    }
    if (s === 'COMPLETED') return { variant: 'secondary', className: '' };
    if (s === 'CANCELLED') return { variant: 'secondary', className: 'text-muted-foreground' };
    return { variant: 'destructive', className: '' };
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-lg font-medium">Task Control</h1>
          <p className="text-sm text-muted-foreground mt-1">Assign and monitor fleet objectives.</p>
        </div>
        <Button onClick={() => setIsCreatingTask(true)} className="whitespace-nowrap">
          + CREATE TASK
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={ListTodo} title="Total Tasks" value={totalTasks} subtext="in system" />
        <MetricCard icon={Play} title="Active" value={activeTasks} subtext="in progress" />
        <MetricCard icon={Check} title="Completed" value={completedTasks} subtext="done" />
        <MetricCard icon={X} title="Failed" value={failedTasks} subtext="needs review" />
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-muted/30 flex items-center justify-between">
          <div className="text-lg font-medium">Task List</div>
          <div className="text-sm text-muted-foreground">{robots.length} robots</div>
        </div>

        <Table className="whitespace-nowrap">
          <TableHeader>
            <TableRow>
              <TableHead className="w-36">Task ID</TableHead>
              <TableHead className="w-36">Robot</TableHead>
              <TableHead>Route</TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className="w-28 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((t) => {
              const pill = statusBadge(t.status);
              const taskId = t.taskId || t.id;

              return (
                <TableRow key={taskId}>
                  <TableCell className="font-mono font-semibold">{taskId}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">{t.robot?.robotId || '—'}</TableCell>
                  <TableCell className="font-medium">
                    {t.pickup} → {t.drop}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={pill.variant}
                      className={`uppercase text-[10px] tracking-wide ${pill.className}`}
                    >
                      {normalizeStatus(t.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {canCancel(t.status) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => cancelTask(taskId)}
                        className="text-destructive hover:bg-muted/50"
                      >
                        Cancel
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
