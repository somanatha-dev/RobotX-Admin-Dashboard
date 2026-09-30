import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.jsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.jsx';

import { LocationCombobox } from '@/components/system/LocationCombobox.jsx';
import { RequiredMark } from '@/components/system/RequiredMark.jsx';
import { useAppActions, useAppState } from '@/context/appContext.js';
import {
  CHASSIS_OPTIONS,
  INITIAL_BATTERY_FIELD,
  SPECIFICATION_FIELDS,
  examplePlaceholder,
  missingRequiredInputs,
  validateSpecification,
} from '@/lib/robotSpecification.js';

export default function CommissionPage() {
  const rrNavigate = useNavigate();
  const { commission } = useAppActions();
  const { robots } = useAppState();

  // The chassis vocabulary is the backend's own — the value sent is the token the
  // `AgentClass` is keyed by, not a display string the server then has to guess at.
  const chassisOptions = useMemo(() => CHASSIS_OPTIONS, []);

  const [formData, setFormData] = useState({
    id: 'RBT-1000',
    name: '',
    type: CHASSIS_OPTIONS[0].value,
    zone: '',
    zoneLat: null,
    zoneLon: null,
  });

  // The unit's specification. Empty rather than pre-filled: a pre-filled mass is a number
  // the operator did not choose but the fleet would be run on.
  const [spec, setSpec] = useState(() =>
    Object.fromEntries([...SPECIFICATION_FIELDS, INITIAL_BATTERY_FIELD].map((f) => [f.key, ''])),
  );
  const [formError, setFormError] = useState('');

  const setSpecField = (key, value) => {
    setFormError('');
    setSpec((prev) => ({ ...prev, [key]: value }));
  };

  const handleCancel = () => {
    // Prefer back navigation to preserve context; fall back to dashboard.
    if (window.history.length > 1) rrNavigate(-1);
    else rrNavigate('/');
  };

  // What is still empty. The button's gate and the note beside it are this one list, so a
  // disabled button always says why — `handleSubmit` cannot, because it never runs.
  // Enabling the button authorises nothing: submitting still goes through `commission`,
  // which asks for the step-up before anything is sent.
  const missing = missingRequiredInputs(spec, [
    { key: 'id', label: 'Unit identifier', value: formData.id },
    { key: 'zone', label: 'Initial assignment zone', value: formData.zone },
  ]);

  const canSubmit = missing.length === 0;

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

    const alreadyExists = Array.isArray(robots) &&
      robots.some((r) => String(r.robotId || '').trim().toLowerCase() === robotId.toLowerCase());
    if (alreadyExists) {
      setFormError(`Unit "${robotId}" is already commissioned. Choose a different identifier.`);
      return;
    }

    // Checked here for immediate feedback; the server validates the same values again and
    // its refusal is what the operator sees if the two ever disagree.
    const validated = validateSpecification(spec, { required: true });
    if (!validated.ok) {
      setFormError(validated.problems.join(' '));
      return;
    }

    commission({
      ...formData,
      id: robotId,
      name,
      zone,
      chassisType: formData.type,
      specification: validated.values,
    });
  };

  const showSelectedZone = String(formData.zone || '').trim().length > 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Commission New Unit</h1>
          <p className="text-sm text-muted-foreground mt-1">Register and authorize a new unit</p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="commission-new-unit"
              disabled={!canSubmit}
              aria-describedby={missing.length > 0 ? 'commission-still-needed' : undefined}
            >
              <ShieldCheck className="w-4 h-4" /> Authorize Commissioning
            </Button>
          </div>
          {/* Guidance, not an error: an untouched form is incomplete, not wrong. */}
          {missing.length > 0 ? (
            <p id="commission-still-needed" aria-live="polite" className="max-w-sm text-right text-xs text-muted-foreground">
              Complete the required fields (<span aria-hidden>*</span>) to continue. Still empty:{' '}
              <span className="font-medium text-foreground">
                {missing.map((input) => input.label).join(', ')}
              </span>
            </p>
          ) : null}
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
                      Unit Identifier <RequiredMark />
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
                      <Label>
                        Initial Assignment Zone <RequiredMark />
                      </Label>
                    </div>

                    <LocationCombobox
                      inputValue={formData.zone}
                      onInputValueChange={(value) => {
                        setFormError('');
                        // When the user edits the text manually, clear any saved
                        // coordinates so stale coords don't attach to a new name.
                        setFormData((prev) => ({
                          ...prev,
                          zone: value,
                          zoneLat: null,
                          zoneLon: null,
                        }));
                      }}
                      onChange={(loc) => {
                        if (!loc) return;
                        setFormError('');
                        // A suggestion was selected — save zone text + coordinates.
                        setFormData((prev) => ({
                          ...prev,
                          zone: loc.place_name,
                          zoneLat: loc.lat,
                          zoneLon: loc.lon,
                        }));
                      }}
                      placeholder="Search college, building, area…"
                      country="IN"
                      debounceMs={350}
                      limit={7}
                    />

                    <div className="mt-2 text-xs text-muted-foreground">
                      Search by name — colleges, buildings, landmarks are supported.
                      Select a suggestion to pin exact coordinates.
                    </div>

                    {showSelectedZone ? (
                      <div className="mt-3 flex items-center gap-2">
                        <Badge variant="secondary" className="max-w-full">
                          <span className="truncate">{formData.zone}</span>
                        </Badge>
                        {formData.zoneLat !== null && formData.zoneLon !== null ? (
                          <Badge variant="outline" className="max-w-full">
                            <span className="truncate">Pinned</span>
                          </Badge>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          onClick={() => setFormData((prev) => ({ ...prev, zone: '', zoneLat: null, zoneLon: null }))}
                        >
                          Clear
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>

              </CardContent>
            </Card>

            {/* Specification — the values the assignment engine reasons from */}
            <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm">
              <CardHeader className="p-6">
                <CardTitle className="text-lg font-medium">Unit Specification</CardTitle>
                <CardDescription>
                  The physical configuration of this unit. These are the values the
                  assignment engine reasons from — the energy model reads the pack, the
                  feasibility gate reads the payload limit — so they are entered, never
                  defaulted.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 pt-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {SPECIFICATION_FIELDS.map((field) => (
                    <div key={field.key}>
                      <Label htmlFor={`spec-${field.key}`} className="mb-2 block">
                        {field.label} <span className="text-muted-foreground font-normal">({field.unit})</span>{' '}
                        <RequiredMark />
                      </Label>
                      <Input
                        id={`spec-${field.key}`}
                        type="number"
                        inputMode="decimal"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={spec[field.key]}
                        onChange={(e) => setSpecField(field.key, e.target.value)}
                        placeholder={examplePlaceholder(field)}
                        required
                        autoComplete="off"
                        className="font-mono"
                      />
                    </div>
                  ))}
                </div>

                <div className="mt-6 border-t border-border/60 pt-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    <div>
                      <Label htmlFor="spec-initialBatteryPct" className="mb-2 block">
                        {INITIAL_BATTERY_FIELD.label}{' '}
                        <span className="text-muted-foreground font-normal">({INITIAL_BATTERY_FIELD.unit})</span>{' '}
                        <RequiredMark />
                      </Label>
                      <Input
                        id="spec-initialBatteryPct"
                        type="number"
                        inputMode="decimal"
                        min={INITIAL_BATTERY_FIELD.min}
                        max={INITIAL_BATTERY_FIELD.max}
                        step={INITIAL_BATTERY_FIELD.step}
                        value={spec[INITIAL_BATTERY_FIELD.key]}
                        onChange={(e) => setSpecField(INITIAL_BATTERY_FIELD.key, e.target.value)}
                        placeholder={examplePlaceholder(INITIAL_BATTERY_FIELD)}
                        required
                        autoComplete="off"
                        className="font-mono"
                      />
                    </div>
                    <div className="sm:col-span-2 flex items-end">
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          Configured initial state, not a measured reading.
                        </span>{' '}
                        This is the state of charge the unit is declared to start at. It is
                        recorded as configuration and is not fleet history.
                      </div>
                    </div>
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
