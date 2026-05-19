import React, { useState } from 'react';
import { ListTodo } from 'lucide-react';

import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';

export default function CreateTaskModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ pickup: '', drop: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const geocodeOne = async (query) => {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    const q = String(query || '').trim();
    if (!q) return null;
    if (!token) throw new Error('Missing VITE_MAPBOX_TOKEN');

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${encodeURIComponent(
      token
    )}&autocomplete=true&limit=1&types=address,poi`;

    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to geocode address');
    const data = await res.json();
    const feature = data?.features?.[0];
    if (!feature || !Array.isArray(feature.center) || feature.center.length < 2) return null;

    const [lon, lat] = feature.center;
    return { label: feature.place_name || q, lat, lon };
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const pickupGeo = await geocodeOne(form.pickup);
      const dropGeo = await geocodeOne(form.drop);

      if (!pickupGeo) throw new Error('Pickup address not found');
      if (!dropGeo) throw new Error('Drop address not found');

      // No robotId — backend DTARO cost function selects the optimal robot.
      onCreate({
        pickup: pickupGeo.label,
        pickupLat: pickupGeo.lat,
        pickupLon: pickupGeo.lon,
        drop: dropGeo.label,
        dropLat: dropGeo.lat,
        dropLon: dropGeo.lon,
      });
    } catch (err) {
      setError(err?.message || 'Failed to create task');
    } finally {
      setIsSubmitting(false);
    }
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
            <div className="mt-2 text-sm font-medium text-foreground">
              Robot auto-assigned by DTARO cost function (distance, battery, utilization).
            </div>
          </Card>

          {error ? <div className="text-sm text-destructive font-medium">{error}</div> : null}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Pickup</Label>
              <Input
                value={form.pickup}
                onChange={(e) => setForm((prev) => ({ ...prev, pickup: e.target.value }))}
                placeholder="e.g. Gate 1, RNSIT"
              />
            </div>
            <div className="space-y-2">
              <Label>Drop</Label>
              <Input
                value={form.drop}
                onChange={(e) => setForm((prev) => ({ ...prev, drop: e.target.value }))}
                placeholder="e.g. Block C, RNSIT"
              />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={isSubmitting || !form.pickup.trim() || !form.drop.trim()}
            >
              {isSubmitting ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
