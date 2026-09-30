import React, { useState } from 'react';
import { ListTodo, MapPin, Package } from 'lucide-react';

import { Button } from '@/components/ui/button.jsx';
import { Card } from '@/components/ui/card.jsx';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.jsx';
import { campusTaskLocations } from '@/features/tasks/campusLocations.js';
import { CHASSIS_OPTIONS } from '@/lib/robotSpecification.js';
import { CAMPUS_REGISTRY } from '@/features/maps/campus/campusRegistry.js';

const EMPTY_LOC = { text: '', lat: null, lon: null };

export default function CreateTaskModal({ onClose, onCreate }) {
  const [pickup, setPickup] = useState(EMPTY_LOC);
  const [drop, setDrop]     = useState(EMPTY_LOC);

  // §15.1's payload declaration. Mass **and** its tolerance, because feasibility uses the
  // upper bound of the tolerance and the expectation is not a substitute for it — a
  // payload with a mass and no tolerance is one the gate returns INDETERMINATE on. Neither
  // is pre-filled: a default tolerance would declare a precision nobody stated.
  const [massKg, setMassKg] = useState('');
  const [massToleranceKg, setMassToleranceKg] = useState('');

  // The agent class this task asks for. Required, because every unit in this fleet is
  // commissioned as one of the two and a task that names neither can be matched to
  // anything — which reads as "any robot will do" and is the assumption §7.5 F21 exists to
  // remove.
  const [requestedChassisType, setRequestedChassisType] = useState(CHASSIS_OPTIONS[0].value);

  // The campus the task is for. Required and not pre-selected: it decides the operating
  // region the task is submitted to (`lib/taskRequest.js`), and the backend has no
  // default region — so the operator names it.
  const [campusId, setCampusId] = useState('');

  // Pickup and drop come from the selected campus's own locations, inside its boundary
  // (see features/tasks/campusLocations.js) — never from a citywide search.
  const { locations: campusLocations } = campusId ? campusTaskLocations(campusId) : { locations: [] };
  const locationById = (id) => campusLocations.find((l) => l.id === id) || null;
  const chooseLocation = (setter) => (id) => {
    setError('');
    const loc = locationById(id);
    setter(loc ? { id: loc.id, text: loc.name, lat: loc.lat, lon: loc.lon } : EMPTY_LOC);
  };
  const chooseCampus = (value) => {
    setError('');
    setCampusId(value);
    // A location belongs to one campus; changing campus clears both ends.
    setPickup(EMPTY_LOC);
    setDrop(EMPTY_LOC);
  };

  const [error, setError]   = useState('');

  const canCreate =
    Boolean(campusId) &&
    pickup.text.trim().length > 0 && pickup.lat !== null &&
    drop.text.trim().length > 0   && drop.lat !== null &&
    String(massKg).trim().length > 0 &&
    String(massToleranceKg).trim().length > 0 &&
    Boolean(requestedChassisType);

  const handleCreate = () => {
    setError('');
    if (!campusId) { setError('Select the campus this task is for.'); return; }
    if (!pickup.lat || !pickup.lon) { setError('Select a pickup location on the campus.'); return; }
    if (!drop.lat   || !drop.lon)   { setError('Select a drop location on the campus.');   return; }
    // Two names can share one point (they do on RNSIT); a delivery needs two places.
    if (pickup.lat === drop.lat && pickup.lon === drop.lon) {
      setError('Pickup and drop are the same place. Choose two different locations.');
      return;
    }

    const mass = Number(massKg);
    const tolerance = Number(massToleranceKg);

    if (!Number.isFinite(mass) || mass <= 0) {
      setError('Payload mass must be a number greater than zero.');
      return;
    }
    if (mass > 5000) {
      setError('Payload mass must be at most 5000 kg.');
      return;
    }
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      setError('Payload tolerance must be a number and cannot be negative.');
      return;
    }
    if (tolerance > mass) {
      setError('Payload tolerance cannot exceed the declared mass.');
      return;
    }
    if (!requestedChassisType) {
      setError('Select the model this task requires.');
      return;
    }

    onCreate({
      campusId,
      pickup:    pickup.text,
      pickupLat: pickup.lat,
      pickupLon: pickup.lon,
      drop:      drop.text,
      dropLat:   drop.lat,
      dropLon:   drop.lon,
      payload:   { massKg: mass, massToleranceKg: tolerance },
      requestedChassisType,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      {/*
        overflow-visible lets the suggestion dropdowns escape the dialog boundary.
        The dialog itself is sized to fit compactly — no extra blank space.
      */}
      {/*
        `overflow-visible` lets the suggestion dropdowns escape the dialog boundary — they
        are absolutely positioned inside their own relative container, so a clipping
        ancestor would cut them off. The body below carries the height cap instead, so the
        Create button stays reachable on a short viewport now that the form collects a
        payload and a model as well as two locations.
      */}
      <DialogContent className="max-w-lg p-0 overflow-visible">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border/60 bg-muted/30 rounded-t-lg flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <ListTodo className="w-4 h-4" />
          </div>
          <DialogTitle className="text-base">Create Task</DialogTitle>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 max-h-[78vh] overflow-y-auto">
          {/* How the unit is chosen. The legacy DTARO sentence was retired with the
              dispatcher it described; what selects an agent now is candidate generation,
              the feasibility gate and the solve. */}
          <Card className="px-4 py-3 bg-muted/40">
            <div className="text-xs text-muted-foreground">
              The unit is chosen by the{' '}
              <span className="font-semibold text-foreground">assignment engine</span> —
              candidate generation, the feasibility gate, then the cost solve. The model and
              payload below are requirements it must satisfy, not a choice of robot.
            </div>
          </Card>

          {error ? (
            <div className="text-sm text-destructive font-medium bg-destructive/10 px-3 py-2 rounded-lg border border-destructive/20">
              {error}
            </div>
          ) : null}

          {/* Campus — first, because it decides the operating region the task is submitted
              to and which locations may be chosen below. */}
          <div className="space-y-1.5">
            <Label className="text-sm">Campus</Label>
            <Select value={campusId} onValueChange={chooseCampus}>
              <SelectTrigger>
                <SelectValue placeholder="Select a campus" />
              </SelectTrigger>
              <SelectContent>
                {CAMPUS_REGISTRY.map((campus) => (
                  <SelectItem key={campus.id} value={campus.id} disabled={!campus.regionId}>
                    {campus.regionId ? campus.name : `${campus.name} (no operating region)`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {[
            { key: 'pickup', label: 'Pickup', icon: 'text-emerald-600', value: pickup, set: setPickup },
            { key: 'drop', label: 'Drop', icon: 'text-rose-500', value: drop, set: setDrop },
          ].map((end) => (
            <div key={end.key} className="space-y-1.5" data-location-field={end.key}>
              <Label className="flex items-center gap-1.5 text-sm">
                <MapPin className={`w-3.5 h-3.5 ${end.icon}`} />
                {end.label}
              </Label>
              <Select
                value={end.value.id || ''}
                onValueChange={chooseLocation(end.set)}
                disabled={!campusId || campusLocations.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      !campusId
                        ? 'Select a campus first'
                        : campusLocations.length === 0
                          ? 'No campus locations available'
                          : `Select a ${end.label.toLowerCase()} location`
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {campusLocations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {end.value.lat !== null && (
                <div className={`text-[10px] font-mono pl-1 ${end.icon}`}>
                  ✓ {end.value.lat.toFixed(5)}, {end.value.lon.toFixed(5)}
                </div>
              )}
            </div>
          ))}
          {campusId && campusLocations.length > 0 ? (
            <div className="text-[10px] text-muted-foreground pl-1 -mt-2">
              Locations inside the campus boundary only.
            </div>
          ) : null}

          {/* Payload — §15.1's declaration: mass with its tolerance */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-sm">
              <Package className="w-3.5 h-3.5 text-amber-600" />
              Payload
            </Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0.01}
                  max={5000}
                  step={0.1}
                  value={massKg}
                  onChange={(e) => { setError(''); setMassKg(e.target.value); }}
                  placeholder="Mass"
                  className="font-mono"
                />
                <div className="mt-1 text-[10px] text-muted-foreground pl-1">Mass (kg)</div>
              </div>
              <div>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={5000}
                  step={0.1}
                  value={massToleranceKg}
                  onChange={(e) => { setError(''); setMassToleranceKg(e.target.value); }}
                  placeholder="Tolerance"
                  className="font-mono"
                />
                <div className="mt-1 text-[10px] text-muted-foreground pl-1">± Tolerance (kg)</div>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground pl-1">
              Declared masses are frequently wrong, so feasibility is checked against
              mass + tolerance. Both are required.
            </div>
          </div>

          {/* Requested model — matched against the unit's attested capabilities */}
          <div className="space-y-1.5">
            <Label className="text-sm">Required model</Label>
            <Select value={requestedChassisType} onValueChange={(v) => { setError(''); setRequestedChassisType(v); }}>
              <SelectTrigger>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {CHASSIS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="text-[10px] text-muted-foreground pl-1">
              Becomes a requirement on the task, matched against each unit&apos;s attested
              capabilities. Units of another model are not eligible.
            </div>
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
