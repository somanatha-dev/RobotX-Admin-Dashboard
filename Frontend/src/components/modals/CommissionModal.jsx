import React, { useState } from 'react';
import { Plus, ShieldCheck } from 'lucide-react';

import { Button } from '../ui/button.jsx';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';

export default function CommissionModal({ onClose, onCommission }) {
  const [formData, setFormData] = useState({ id: 'RBT-1000', type: 'Rover', zone: 'Sector 1A' });

  const handleSubmit = (e) => {
    e.preventDefault();
    onCommission(formData);
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <div className="p-5 border-b border-border/60 bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Plus className="w-5 h-5" />
            </div>
            <DialogTitle>Commission New Unit</DialogTitle>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="space-y-2">
            <Label>Unit Identifier</Label>
            <Input
              type="text"
              value={formData.id}
              onChange={(e) => setFormData({ ...formData, id: e.target.value })}
              placeholder="RBT-1234"
              required
              className="font-mono font-semibold"
            />
          </div>

          <div className="space-y-2">
            <Label>Chassis Type</Label>
            <select
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              className="flex h-10 w-full items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option>Rover (Ground)</option>
              <option>Drone (Aerial)</option>
              <option>Bipedal (Indoor)</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label>Initial Assignment Zone</Label>
            <select
              value={formData.zone}
              onChange={(e) => setFormData({ ...formData, zone: e.target.value })}
              className="flex h-10 w-full items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option>Sector 1A (Logistics)</option>
              <option>Sector 7G (Assembly)</option>
              <option>Perimeter Patrol</option>
            </select>
          </div>

          <div className="pt-4 border-t border-border/60 flex gap-3">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="flex-2">
              <ShieldCheck className="w-4 h-4" /> Authorize Commissioning
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
