import React from 'react';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '../ui/badge.jsx';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Dialog, DialogContent } from '../ui/dialog.jsx';

export default function DecisionRequiredModal({
  decisionRequest,
  onWait,
  onReroute,
  onCancel,
}) {
  if (!decisionRequest) return null;

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent className="max-w-md p-0 overflow-hidden" showClose={false}>
        <div className="p-4 flex justify-between items-center border-b border-border/60 bg-muted/30">
          <div className="flex items-center gap-2">
            <Badge variant="destructive" className="gap-2">
              <AlertTriangle className="w-4 h-4" /> DECISION REQUIRED
            </Badge>
          </div>
          <div className="text-lg font-mono font-semibold">
            {String(Math.floor(decisionRequest.countdown / 60)).padStart(2, '0')}
            :{String(decisionRequest.countdown % 60).padStart(2, '0')}
          </div>
        </div>

        <div className="p-6 space-y-5">
          <Card className="p-3 bg-muted/30">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground block text-xs uppercase mb-0.5">Robot ID</span>
                <span className="font-mono font-semibold text-foreground">{decisionRequest.robotId}</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-xs uppercase mb-0.5">Task ID</span>
                <span className="font-mono font-semibold text-foreground">{decisionRequest.taskId}</span>
              </div>
            </div>
          </Card>

          <div>
            <span className="text-foreground font-medium block mb-2 text-sm">{decisionRequest.issue}</span>
            <div className="relative h-40 rounded-lg overflow-hidden border border-border/60 shadow-inner bg-muted">
              <div
                className="absolute inset-0 bg-cover bg-center opacity-80 mix-blend-luminosity"
                style={{
                  backgroundImage:
                    "url('https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&q=80&w=800')",
                }}
              />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onWait}>
              WAIT
            </Button>
            <Button type="button" className="flex-1" onClick={onReroute}>
              REROUTE
            </Button>
            <Button type="button" variant="destructive" className="flex-1" onClick={onCancel}>
              CANCEL
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
