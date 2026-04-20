import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, ShieldCheck } from 'lucide-react';

import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.jsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.jsx';

import { LocationCombobox } from '../components/system/LocationCombobox.tsx';
import { useAppActions } from '../context/appContext.js';

export default function CommissionPage() {
  const rrNavigate = useNavigate();
  const { commission } = useAppActions();

  const chassisOptions = useMemo(
    () => [
      { label: 'Rover (Ground)', value: 'Rover (Ground)' },
      { label: 'Drone (Aerial)', value: 'Drone (Aerial)' },
    ],
    []
  );

  const [formData, setFormData] = useState({
    id: 'RBT-1000',
    name: '',
    type: chassisOptions[0].value,
    zone: '',
    zoneLat: null,
    zoneLon: null,
  });
  const [formError, setFormError] = useState('');

  const handleCancel = () => {
    // Prefer back navigation to preserve context; fall back to dashboard.
    if (window.history.length > 1) rrNavigate(-1);
    else rrNavigate('/');
  };

  const canSubmit =
    String(formData.id || '').trim().length > 0 && String(formData.zone || '').trim().length > 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    setFormError('');

    const robotId = String(formData.id || '').trim();
    const name = String(formData.name || '').trim();
    const zone = String(formData.zone || '').trim();

    if (!robotId) {
      setFormError('Unit Identifier is required.');
      return;
    }

    if (!zone) {
      setFormError('Initial Assignment Zone is required.');
      return;
    }

    commission({
      ...formData,
      id: robotId,
      name,
      zone,
    });
  };

  const showSelectedZone =
    String(formData.zone || '').trim().length > 0 &&
    formData.zoneLat !== null &&
    formData.zoneLon !== null;

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Commission New Unit</h1>
          <p className="text-sm text-muted-foreground mt-1">Register and authorize a new unit</p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button type="submit" form="commission-new-unit" disabled={!canSubmit}>
            <ShieldCheck className="w-4 h-4" /> Authorize Commissioning
          </Button>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: form (2/3) */}
        <div className="lg:col-span-2">
          <form id="commission-new-unit" onSubmit={handleSubmit} className="space-y-6">
            <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm">
              <CardHeader className="p-6">
                <CardTitle className="text-lg font-medium">Basic Information</CardTitle>
                <CardDescription>
                  Set a friendly name and a stable identifier for this unit.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 pt-0">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div>
                    <Label htmlFor="unit-name" className="mb-2 block">
                      Unit Name (Optional)
                    </Label>
                    <Input
                      id="unit-name"
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="Warehouse Rover A"
                      autoComplete="off"
                    />
                    <div className="mt-2 text-xs text-muted-foreground">Used for display only.</div>
                  </div>

                  <div>
                    <Label htmlFor="unit-id" className="mb-2 block">
                      Unit Identifier
                    </Label>
                    <Input
                      id="unit-id"
                      type="text"
                      value={formData.id}
                      onChange={(e) => setFormData({ ...formData, id: e.target.value })}
                      placeholder="RBT-1234"
                      required
                      autoComplete="off"
                      className="font-mono font-semibold"
                    />
                    <div className="mt-2 text-xs text-muted-foreground">Must be unique (e.g. RBT-1000).</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm">
              <CardHeader className="p-6">
                <CardTitle className="text-lg font-medium">Configuration</CardTitle>
                <CardDescription>
                  Choose the chassis type and assign the initial operating zone.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 pt-0">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div>
                    <Label className="mb-2 block">Chassis Type</Label>
                    <Select
                      value={formData.type}
                      onValueChange={(value) => setFormData({ ...formData, type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select chassis" />
                      </SelectTrigger>
                      <SelectContent>
                        {chassisOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-muted-foreground" />
                      <Label>Initial Assignment Zone</Label>
                    </div>

                    <LocationCombobox
                      inputValue={formData.zone}
                      onInputValueChange={(value) => {
                        setFormError('');
                        setFormData({
                          ...formData,
                          zone: value,
                          zoneLat: null,
                          zoneLon: null,
                        });
                      }}
                      onChange={(loc) => {
                        if (!loc) return;
                        setFormError('');
                        setFormData({
                          ...formData,
                          zone: loc.place_name,
                          zoneLat: loc.lat,
                          zoneLon: loc.lon,
                        });
                      }}
                      placeholder="Search an area (India)…"
                      country="IN"
                      debounceMs={450}
                    />

                    <div className="mt-2 text-xs text-muted-foreground">
                      Start typing to see suggestions. You can also submit a custom zone name.
                    </div>

                    {showSelectedZone ? (
                      <div className="mt-3 flex items-center gap-2">
                        <Badge variant="secondary" className="max-w-full">
                          <span className="truncate">{formData.zone}</span>
                        </Badge>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          onClick={() => setFormData({ ...formData, zone: '', zoneLat: null, zoneLon: null })}
                        >
                          Clear
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>

                {formError ? (
                  <div className="mt-6 rounded-lg bg-destructive/10 text-destructive px-4 py-3 text-sm font-medium">
                    {formError}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </form>
        </div>

        {/* Right: info panel (1/3) */}
        <aside className="lg:col-span-1">
          <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm bg-muted/40">
            <CardHeader className="p-6">
              <CardTitle className="text-lg font-medium">Commissioning Info</CardTitle>
              <CardDescription>What this action does and what happens next.</CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0">
              <div className="text-sm text-muted-foreground space-y-4">
                <p>
                  Commissioning registers a unit and assigns its initial operating zone.
                </p>

                <div>
                  <div className="text-sm font-medium text-foreground">After authorization</div>
                  <ul className="mt-2 list-disc pl-5 space-y-2">
                    <li>A unit profile is created (or updated if it already exists).</li>
                    <li>The selected zone becomes the unit’s initial assignment.</li>
                    <li>You’ll be redirected to the Units list.</li>
                  </ul>
                </div>

                <div>
                  <div className="text-sm font-medium text-foreground">Tips</div>
                  <ul className="mt-2 list-disc pl-5 space-y-2">
                    <li>Make sure the identifier is unique and stable.</li>
                    <li>Choosing a suggestion helps keep coordinates consistent.</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
