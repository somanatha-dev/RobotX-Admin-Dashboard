import React from 'react';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card } from '@/components/ui/card.jsx';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.jsx';
import { OBSTACLE_NO_ACTION_NOTE } from '@/lib/obstacleAlert.js';

// FS-06 — an obstacle report, shown as information (see lib/obstacleAlert.js). There is no
// countdown, no reroute claim and no REROUTE button: the only reroute the backend offers
// is the legacy `/tasks/:id/reroute`, which runs outside the assignment engine (BG-09).
// Dismissing only closes this dialog. (The file keeps its name; nothing here asks for a
// decision any more.)

function clock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString();
}

function Field({ label, value, mono = true }) {
  return (
    <div>
      <span className="text-muted-foreground block text-xs uppercase mb-0.5">{label}</span>
      <span className={`${mono ? 'font-mono ' : ''}font-semibold text-foreground`}>{value}</span>
    </div>
  );
}

export default function DecisionRequiredModal({ decisionRequest: alert, onDismiss }) {
  if (!alert) return null;

  const position =
    typeof alert.lat === 'number' && typeof alert.lon === 'number'
      ? `${alert.lat.toFixed(5)}, ${alert.lon.toFixed(5)}`
      : 'Not reported';

  return (
    <Dialog open onOpenChange={(open) => (!open ? onDismiss() : undefined)}>
      <DialogContent className="max-w-md p-0 overflow-hidden" data-obstacle-alert>
        <div className="p-4 flex items-center gap-2 border-b border-border/60 bg-muted/30">
          <Badge variant="destructive" className="gap-2">
            <AlertTriangle className="w-4 h-4" /> OBSTACLE REPORTED
          </Badge>
          <DialogTitle className="sr-only">Obstacle reported</DialogTitle>
        </div>

        <div className="p-6 space-y-5">
          <Card className="p-3 bg-muted/30">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Field label="Reported by" value={alert.robotId || 'Not reported'} />
              <Field
                label="Robot's current task"
                value={alert.taskId || 'None reported'}
              />
              <Field label="Severity" value={alert.severity || 'Not reported'} />
              <Field label="Zone" value={alert.zone || 'Not reported'} mono={false} />
              <Field label="Position" value={position} />
              <Field label="Obstacle" value={alert.obstacleId || 'Not reported'} />
              <Field label="Reported at" value={clock(alert.reportedAtMs) || 'Not reported'} />
              <Field label="Expires at" value={clock(alert.expiresAtMs) || 'Not reported'} />
            </div>
          </Card>

          <div
            role="note"
            data-obstacle-note
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900"
          >
            {OBSTACLE_NO_ACTION_NOTE}
          </div>

          <Button type="button" variant="outline" className="w-full" onClick={onDismiss}>
            DISMISS
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
