import React, { useState } from 'react';
import { ListTodo, MapPin } from 'lucide-react';

import { Button } from '@/components/ui/button.jsx';
import { Card } from '@/components/ui/card.jsx';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.jsx';
import { Label } from '@/components/ui/label.jsx';
import { LocationCombobox } from '@/components/system/LocationCombobox.jsx';

const EMPTY_LOC = { text: '', lat: null, lon: null };

export default function CreateTaskModal({ onClose, onCreate }) {
  const [pickup, setPickup] = useState(EMPTY_LOC);
  const [drop, setDrop]     = useState(EMPTY_LOC);
  const [error, setError]   = useState('');

  const canCreate =
    pickup.text.trim().length > 0 && pickup.lat !== null &&
    drop.text.trim().length > 0   && drop.lat !== null;

  const handleCreate = () => {
    setError('');
    if (!pickup.lat || !pickup.lon) { setError('Select a pickup location from the suggestions.'); return; }
    if (!drop.lat   || !drop.lon)   { setError('Select a drop location from the suggestions.');   return; }
    onCreate({
      pickup:    pickup.text,
      pickupLat: pickup.lat,
      pickupLon: pickup.lon,
      drop:      drop.text,
      dropLat:   drop.lat,
      dropLon:   drop.lon,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      {/*
        overflow-visible lets the suggestion dropdowns escape the dialog boundary.
        The dialog itself is sized to fit compactly — no extra blank space.
      */}
      <DialogContent className="max-w-md p-0 overflow-visible">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border/60 bg-muted/30 rounded-t-lg flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <ListTodo className="w-4 h-4" />
          </div>
          <DialogTitle className="text-base">Create Task</DialogTitle>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* DTARO info */}
          <Card className="px-4 py-3 bg-muted/40">
            <div className="text-xs text-muted-foreground">
              Robot auto-assigned by{' '}
              <span className="font-semibold text-foreground">DTARO</span> cost function
              (distance · battery · utilization).
            </div>
          </Card>

          {error ? (
            <div className="text-sm text-destructive font-medium bg-destructive/10 px-3 py-2 rounded-lg border border-destructive/20">
              {error}
            </div>
          ) : null}

          {/* Pickup */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-sm">
              <MapPin className="w-3.5 h-3.5 text-emerald-600" />
              Pickup
            </Label>
            <div className="relative">
              <LocationCombobox
                inputValue={pickup.text}
                onInputValueChange={(v) => { setError(''); setPickup({ text: v, lat: null, lon: null }); }}
                onChange={(loc) => { if (!loc) return; setError(''); setPickup({ text: loc.place_name, lat: loc.lat, lon: loc.lon }); }}
                placeholder="e.g. Gate 1, RNSIT"
                direction="down"
                country="IN"
                debounceMs={300}
                limit={6}
              />
            </div>
            {pickup.lat !== null && (
              <div className="text-[10px] text-emerald-600 font-mono pl-1">
                ✓ {pickup.lat.toFixed(5)}, {pickup.lon.toFixed(5)}
              </div>
            )}
          </div>

          {/* Drop — dropdown opens downward; modal is short enough there's room below */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-sm">
              <MapPin className="w-3.5 h-3.5 text-rose-500" />
              Drop
            </Label>
            <div className="relative">
              <LocationCombobox
                inputValue={drop.text}
                onInputValueChange={(v) => { setError(''); setDrop({ text: v, lat: null, lon: null }); }}
                onChange={(loc) => { if (!loc) return; setError(''); setDrop({ text: loc.place_name, lat: loc.lat, lon: loc.lon }); }}
                placeholder="e.g. Block C, RNSIT"
                direction="down"
                country="IN"
                debounceMs={300}
                limit={6}
              />
            </div>
            {drop.lat !== null && (
              <div className="text-[10px] text-rose-500 font-mono pl-1">
                ✓ {drop.lat.toFixed(5)}, {drop.lon.toFixed(5)}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" className="flex-1" disabled={!canCreate} onClick={handleCreate}>
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
