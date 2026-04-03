import React, { useState } from 'react';
import { ListTodo } from 'lucide-react';

import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';

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
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <div className="p-5 border-b border-border/60 bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <ListTodo className="w-5 h-5" />
            </div>
            <DialogTitle>Create Task</DialogTitle>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <Card className="p-4 bg-muted/30">
            <div className="text-sm text-muted-foreground">Assignment</div>
            <div className="mt-2 text-sm font-medium text-foreground">Robot is auto-assigned based on availability.</div>
          </Card>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Pickup</Label>
              <Input
                value={form.pickup}
                onChange={(e) => setForm((prev) => ({ ...prev, pickup: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Drop</Label>
              <Input
                value={form.drop}
                onChange={(e) => setForm((prev) => ({ ...prev, drop: e.target.value }))}
              />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1">
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
