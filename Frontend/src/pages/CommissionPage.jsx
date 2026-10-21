import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MapPin, RotateCcw, ShieldCheck } from 'lucide-react';

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
import { connectPathFor } from '@/lib/robotEnrollment.js';
import { RecommissionRetiredUnit } from '@/features/robots/RecommissionRetiredUnit.jsx';
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

  // Two distinct operations on one page, chosen explicitly: commissioning a new unit, or
  // recommissioning a retired one (its own record). Held in the URL so a refusal can link
  // straight to the second with the unit preselected, and a refresh keeps the choice.
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = searchParams.get('mode') === 'recommission' ? 'recommission' : 'new';
  const preselectedRetiredId = String(searchParams.get('robotId') || '').trim();
  const chooseMode = (next, robotId) => {
    const params = new URLSearchParams();
    if (next === 'recommission') {
      params.set('mode', 'recommission');
      if (robotId) params.set('robotId', robotId);
    }
    setSearchParams(params);
  };

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
  // A unit with this identifier already exists: offer its Connect page instead of a second
  // commissioning, which the backend would refuse anyway.
  const [existingId, setExistingId] = useState('');
  // The server refused the identifier because it belongs to a retired robot: offer the
  // explicit recommissioning path for that unit (never taken automatically).
  const [retiredId, setRetiredId] = useState('');

  const setSpecField = (key, value) => {
    setFormError('');
    setExistingId('');
    setRetiredId('');
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
    setExistingId('');
    setRetiredId('');

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

    const existing = Array.isArray(robots)
      ? robots.find((r) => String(r.robotId || '').trim().toLowerCase() === robotId.toLowerCase())
      : null;
    if (existing) {
      setFormError(
        `Unit "${existing.robotId}" is already commissioned. Choose a different identifier, or connect the existing unit.`,
      );
      setExistingId(existing.robotId);
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
      onRetiredId: (id) => {
        setFormError(
          `"${id}" belongs to a retired robot, so a new unit cannot use it. If this is that same robot returning, recommission it instead.`,
        );
        setRetiredId(id);
      },
    });
  };

  const showSelectedZone = String(formData.zone || '').trim().length > 0;

  return (
    <div className="w-full max-w-6xl mx-auto pb-32 sm:px-2 lg:px-6 lg:py-6 lg:pb-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 lg:gap-6">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            {mode === 'recommission' ? 'Recommission Retired Unit' : 'Commission New Unit'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {mode === 'recommission'
              ? 'Return a retired robot’s own record to the fleet'
              : 'Register and authorize a new unit'}
          </p>
          <div className="mt-4 flex w-full sm:inline-flex sm:w-auto rounded-lg border border-border/60 p-1" role="group" aria-label="Commissioning operation">
            <Button
              type="button"
              size="sm"
              variant={mode === 'new' ? 'default' : 'ghost'}
              aria-pressed={mode === 'new'}
              onClick={() => chooseMode('new')}
              className="flex-1 sm:flex-none h-auto min-h-8 whitespace-normal"
            >
              <ShieldCheck className="w-4 h-4" /> Commission new unit
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'recommission' ? 'default' : 'ghost'}
              aria-pressed={mode === 'recommission'}
              onClick={() => chooseMode('recommission')}
              className="flex-1 sm:flex-none h-auto min-h-8 whitespace-normal"
            >
              <RotateCcw className="w-4 h-4" /> Recommission retired robot
            </Button>
          </div>
        </div>

        {/* On a phone the actions are a bar fixed to the bottom of the screen, so the form can
            be submitted from wherever the operator finished filling it in. */}
        <div className="fixed inset-x-0 bottom-0 z-20 flex flex-col gap-1.5 border-t border-border bg-background/95 backdrop-blur px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(0,0,0,0.06)] lg:static lg:z-auto lg:items-end lg:gap-2 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none">
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            {mode === 'new' ? (
              <Button
                type="submit"
                form="commission-new-unit"
                disabled={!canSubmit}
                aria-describedby={missing.length > 0 ? 'commission-still-needed' : undefined}
                // In the phone bar the label may wrap: on a 320px screen it is wider than the
                // space beside Cancel, and clipping it would hide the action.
                className="flex-1 min-w-0 h-auto min-h-10 whitespace-normal leading-tight lg:flex-none lg:h-10 lg:whitespace-nowrap"
              >
                <ShieldCheck className="w-4 h-4 shrink-0" /> Authorize Commissioning
              </Button>
            ) : null}
          </div>
          {/* Guidance, not an error: an untouched form is incomplete, not wrong. */}
          {mode === 'new' ? (
            <>
              {missing.length > 0 ? (
                <p id="commission-still-needed" aria-live="polite" className="line-clamp-2 lg:line-clamp-none lg:max-w-sm lg:text-right text-xs text-muted-foreground">
                  Complete the required fields (<span aria-hidden>*</span>) to continue. Still empty:{' '}
                  <span className="font-medium text-foreground">
                    {missing.map((input) => input.label).join(', ')}
                  </span>
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {mode === 'recommission' ? (
        <RecommissionRetiredUnit key={preselectedRetiredId} initialRobotId={preselectedRetiredId} />
      ) : (
      <div className="mt-5 sm:mt-8 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Left: form (2/3) */}
        <div className="lg:col-span-2">
          <form id="commission-new-unit" onSubmit={handleSubmit} className="space-y-6">
            <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm">
              <CardHeader className="p-4 sm:p-6">
                <CardTitle className="text-lg font-medium">Basic Information</CardTitle>
                <CardDescription>
                  Set a friendly name and a stable identifier for this unit.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
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
                      aria-describedby="unit-id-help"
                      type="text"
                      value={formData.id}
                      onChange={(e) => {
                        setExistingId('');
                        setFormData({ ...formData, id: e.target.value });
                      }}
                      placeholder="RBT-1234"
                      required
                      autoComplete="off"
                      className="font-mono font-semibold"
                    />
                    <div id="unit-id-help" className="mt-2 text-xs text-muted-foreground">
                      Must be unique. The Robot ID must exactly match the ID configured on the physical Pi.
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm">
              <CardHeader className="p-4 sm:p-6">
                <CardTitle className="text-lg font-medium">Configuration</CardTitle>
                <CardDescription>
                  Choose the chassis type and assign the initial operating zone.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
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
              <CardHeader className="p-4 sm:p-6">
                <CardTitle className="text-lg font-medium">Unit Specification</CardTitle>
                <CardDescription>
                  The physical configuration of this unit. These are the values the
                  assignment engine reasons from — the energy model reads the pack, the
                  feasibility gate reads the payload limit — so they are entered, never
                  defaulted.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
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
                    {existingId ? (
                      <div className="mt-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => rrNavigate(connectPathFor(existingId))}>
                          Connect {existingId}
                        </Button>
                      </div>
                    ) : null}
                    {retiredId ? (
                      <div className="mt-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => chooseMode('recommission', retiredId)}>
                          <RotateCcw className="w-4 h-4" /> Recommission {retiredId} instead
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </form>
        </div>

        {/* Right: info panel (1/3) */}
        <aside className="lg:col-span-1">
          <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm bg-muted/40">
            <CardHeader className="p-4 sm:p-6">
              <CardTitle className="text-lg font-medium">Commissioning Info</CardTitle>
              <CardDescription>What this action does and what happens next.</CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="text-sm text-muted-foreground space-y-4">
                <p>
                  Commissioning registers a unit and assigns its initial operating zone.
                </p>

                <div>
                  <div className="text-sm font-medium text-foreground">After authorization</div>
                  <ul className="mt-2 list-disc pl-5 space-y-2">
                    <li>A unit profile is created.</li>
                    <li>The selected zone becomes the unit’s initial assignment.</li>
                    <li>You’ll go straight to connecting the robot: a one-time pairing code and a single command to run on its Pi.</li>
                  </ul>
                </div>

                <div>
                  <div className="text-sm font-medium text-foreground">Tips</div>
                  <ul className="mt-2 list-disc pl-5 space-y-2">
                    <li>Make sure the identifier is unique and stable.</li>
                    <li>A retired robot’s identifier cannot be used for a new unit. To bring that same robot back, choose “Recommission retired robot” above.</li>
                    <li>Choosing a suggestion helps keep coordinates consistent.</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
      )}
    </div>
  );
}
