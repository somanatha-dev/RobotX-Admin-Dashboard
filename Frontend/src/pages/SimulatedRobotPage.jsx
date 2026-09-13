import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, MapPin } from 'lucide-react';

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
import { useAppActions } from '@/context/appContext.js';
import {
  CHASSIS_OPTIONS,
  INITIAL_BATTERY_FIELD,
  PRESET_DECLARED_KEYS,
  PRESET_UNDECLARED,
  SIMULATION_PRESETS,
  SPECIFICATION_FIELDS,
  validateSpecification,
} from '@/lib/robotSpecification.js';
import { RUNTIME } from '@/lib/simulationIdentity.js';

/**
 * Create Simulated Robot — the operator surface for `POST /api/simulator/robot`.
 *
 * ── What this page is NOT ───────────────────────────────────────────────────
 * It is not hardware commissioning with a flag flipped, and it is deliberately not shaped
 * like it. There is no unit identifier field, because the server generates the identifier
 * so a client cannot collide with a physical unit's. There is no count, no fleet size and
 * no bulk form: one submission creates one robot. There is no "simulated" toggle, because
 * everything created here is simulated — that is what the page is. And there is no owner
 * field: the creator is the signed-in operator, derived from the session, and the backend
 * refuses a body that tries to name one.
 *
 * What is left is the legitimate creation information the existing API already takes, on
 * the existing components the commissioning form already uses.
 *
 * ── Creating several is ordinary use, not an error ──────────────────────────
 * This page used to carry a panel for the backend's "you already own a simulated robot"
 * 409. That rule was wrong: one SUPER_ADMIN may have as many simulated robots as they
 * like. The panel is gone along with the constraint, and the success view offers "Create
 * another" so building SIM-001, SIM-002, SIM-003 is one obvious path rather than a
 * re-navigation. There is still no count field and no bulk form — one submission is still
 * one robot.
 *
 * ── The authorisation rule is the server's, and stays the server's ──────────
 * `POST /api/simulator/robot` is SUPER_ADMIN-only and the backend enforces it. This page
 * does not check a role, does not hide itself based on one, and treats a server refusal
 * as what it is: the server's sentence, shown to the operator unchanged. Hiding a button
 * is not authorisation, and a page that decided for itself would be a second copy of a
 * rule that lives on the server.
 */
export default function SimulatedRobotPage() {
  const navigate = useNavigate();
  const { createSimulatedRobot } = useAppActions();

  const chassisOptions = useMemo(() => CHASSIS_OPTIONS, []);

  const [form, setForm] = useState({
    name: '',
    type: CHASSIS_OPTIONS[0].value,
    zone: '',
    zoneLat: null,
    zoneLon: null,
  });

  // Empty rather than pre-filled, for the same reason the commissioning form is: a
  // pre-filled mass is a number the operator did not choose but the engine would reason
  // from. A simulated unit is priced by the same models as a physical one, so its
  // specification is entered with the same care.
  const [spec, setSpec] = useState(() =>
    Object.fromEntries([...SPECIFICATION_FIELDS, INITIAL_BATTERY_FIELD].map((f) => [f.key, ''])),
  );

  // Which preset, if any, the three declared fields currently reflect. Display only — it
  // is never submitted, and the server neither receives nor stores a preset name.
  const [appliedPreset, setAppliedPreset] = useState('');

  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [created, setCreated] = useState(null);

  const setSpecField = (key, value) => {
    setFormError('');
    setSpec((prev) => ({ ...prev, [key]: value }));
    // Typing into a field the preset filled means the operator has overridden it, so the
    // badge stops claiming the form still reflects that preset.
    if (PRESET_DECLARED_KEYS.includes(key)) setAppliedPreset('');
  };

  /**
   * Apply a DEVELOPMENT simulation preset.
   *
   * Fills only the three declared fields and leaves the other four exactly as the
   * operator left them — including empty. It never clears a field: a preset supplies
   * values it has, and has no opinion about the ones it does not, so pressing "Heavy"
   * after entering a battery capacity keeps that capacity.
   *
   * It does overwrite the three fields it *does* declare, which is what selecting a
   * different preset has to mean; that is a visible, deliberate action on three named
   * fields rather than a silent rewrite of the form.
   */
  const applyPreset = (preset) => {
    setFormError('');
    setAppliedPreset(preset.name);
    setSpec((prev) => ({ ...prev, ...Object.fromEntries(
      Object.entries(preset.values).map(([key, value]) => [key, String(value)]),
    ) }));
  };

  const specComplete = [...SPECIFICATION_FIELDS, INITIAL_BATTERY_FIELD].every(
    (field) => String(spec[field.key] ?? '').trim().length > 0,
  );

  const canSubmit =
    !isSubmitting && String(form.zone || '').trim().length > 0 && specComplete;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const zone = String(form.zone || '').trim();
    if (!zone) {
      setFormError('An operating zone is required.');
      return;
    }

    // Checked here for immediate feedback; the server validates the same values again and
    // its refusal is what the operator sees if the two ever disagree.
    const validated = validateSpecification(spec, { required: true });
    if (!validated.ok) {
      setFormError(validated.problems.join(' '));
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createSimulatedRobot({
        name: form.name,
        zone,
        zoneLat: form.zoneLat,
        zoneLon: form.zoneLon,
        chassisType: form.type,
        specification: validated.values,
      });
      setCreated(result);
    } catch (err) {
      // Every refusal is shown with the server's own sentence — a 400 naming a field, or
      // the 403 an operator without SUPER_ADMIN receives. Nothing is classified here and
      // nothing retries: a message written on this side would be a second statement of a
      // rule the server owns.
      setFormError(err?.message || 'The simulated robot could not be created.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const showSelectedZone = String(form.zone || '').trim().length > 0;

  // ── Result panel ──────────────────────────────────────────────────────────
  // Two independent facts, reported separately, exactly as the API reports them: the row
  // was created (that is the 201), and whether a simulator is actually driving it (that
  // is `status`). With the simulator disabled — the default — the honest answer is
  // PERSISTED_NOT_RUNNING, and this panel says so rather than implying the unit is live.
  if (created) {
    const robotId = created?.robot?.robotId || '';
    const runtime = created?.status === RUNTIME.RUNNING ? RUNTIME.RUNNING : RUNTIME.PERSISTED_NOT_RUNNING;
    const reason = created?.simulator?.reason || null;

    return (
      <div className="max-w-3xl mx-auto px-6 py-6">
        <Card className="rounded-2xl border border-border/60 shadow-sm">
          <CardHeader className="p-6">
            <CardTitle className="text-lg font-medium">Simulated unit created</CardTitle>
            <CardDescription>
              One simulated robot was created. You can create as many as you need — each
              request creates exactly one.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-0 space-y-5">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-xl font-semibold">{robotId}</span>
              <Badge variant="secondary">SIMULATED</Badge>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/40 p-4 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="text-sm text-muted-foreground">Simulator runtime</span>
                <span className="font-mono text-sm font-semibold">{runtime}</span>
              </div>
              {runtime === RUNTIME.PERSISTED_NOT_RUNNING ? (
                <p className="text-xs text-muted-foreground">
                  The robot exists in the database and <span className="font-medium">nothing is driving it</span>.
                  {reason ? <> The simulator reported <span className="font-mono">{reason}</span>.</> : null}{' '}
                  Existing as a simulated unit and being run by a simulator are different
                  things, and this unit is currently only the first.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  A simulator instance is running this unit. It becomes online when it
                  connects and authenticates, exactly as hardware does.
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              {/*
                Creating another is the primary action, because it is ordinary use rather
                than a corner case. It resets the form state and returns to it — one more
                submission, one more robot. It is NOT a bulk form: nothing here asks for a
                number and nothing loops.
              */}
              <Button type="button" onClick={() => setCreated(null)}>
                <Cpu className="w-4 h-4" /> Create another
              </Button>
              <Button type="button" variant="outline" onClick={() => navigate('/robots')}>
                View Units
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(`/robots/${encodeURIComponent(robotId)}`)}
                disabled={!robotId}
              >
                Inspect this unit
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-3">
            Create Simulated Robot
            <Badge variant="secondary">SIMULATED</Badge>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Provision one simulated unit. Repeat as often as you need — there is no limit.
            This is not hardware commissioning; to register a physical unit, use
            Commission Unit.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button type="submit" form="create-simulated-robot" disabled={!canSubmit}>
            <Cpu className="w-4 h-4" /> {isSubmitting ? 'Creating…' : 'Create Simulated Robot'}
          </Button>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <form id="create-simulated-robot" onSubmit={handleSubmit} className="space-y-6">
            <Card className="rounded-2xl border border-border/60 shadow-sm">
              <CardHeader className="p-6">
                <CardTitle className="text-lg font-medium">Basic Information</CardTitle>
                <CardDescription>
                  A display name is optional. The identifier is generated by the server —
                  it is not something you choose, so it cannot collide with a physical
                  unit&apos;s.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 pt-0">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div>
                    <Label htmlFor="sim-name" className="mb-2 block">
                      Unit Name (Optional)
                    </Label>
                    <Input
                      id="sim-name"
                      type="text"
                      value={form.name}
                      onChange={(e) => {
                        setFormError('');
                        setForm({ ...form, name: e.target.value });
                      }}
                      placeholder="Test Rover"
                      autoComplete="off"
                    />
                    <div className="mt-2 text-xs text-muted-foreground">Used for display only.</div>
                  </div>

                  <div>
                    <Label className="mb-2 block">Unit Identifier</Label>
                    <div className="h-9 flex items-center rounded-md border border-dashed border-border/70 bg-muted/40 px-3 font-mono text-sm text-muted-foreground">
                      Assigned by the server
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Generated as <span className="font-mono">SIM-…</span> when the unit is created.
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border border-border/60 shadow-sm">
              <CardHeader className="p-6">
                <CardTitle className="text-lg font-medium">Configuration</CardTitle>
                <CardDescription>
                  Choose the chassis type and the operating zone.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 pt-0">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div>
                    <Label className="mb-2 block">Chassis Type</Label>
                    <Select
                      value={form.type}
                      onValueChange={(value) => {
                        setFormError('');
                        setForm({ ...form, type: value });
                      }}
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
                      <Label>Operating Zone</Label>
                    </div>

                    <LocationCombobox
                      inputValue={form.zone}
                      onInputValueChange={(value) => {
                        setFormError('');
                        setForm((prev) => ({ ...prev, zone: value, zoneLat: null, zoneLon: null }));
                      }}
                      onChange={(loc) => {
                        if (!loc) return;
                        setFormError('');
                        setForm((prev) => ({
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
                      Select a suggestion to pin exact coordinates.
                    </div>

                    {showSelectedZone ? (
                      <div className="mt-3 flex items-center gap-2">
                        <Badge variant="secondary" className="max-w-full">
                          <span className="truncate">{form.zone}</span>
                        </Badge>
                        {form.zoneLat !== null && form.zoneLon !== null ? (
                          <Badge variant="outline" className="max-w-full">
                            <span className="truncate">Pinned</span>
                          </Badge>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          onClick={() =>
                            setForm((prev) => ({ ...prev, zone: '', zoneLat: null, zoneLon: null }))
                          }
                        >
                          Clear
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border border-border/60 shadow-sm">
              <CardHeader className="p-6">
                <CardTitle className="text-lg font-medium">Unit Specification</CardTitle>
                <CardDescription>
                  A simulated unit is the same kind of agent to the assignment engine as a
                  physical one — the same class, the same energy and container models — so
                  it is specified the same way, and the values are entered rather than
                  defaulted.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 pt-0">
                {/*
                  The three DEVELOPMENT simulation presets. Each fills mass, normal speed
                  and payload capacity — the three values the owner declared per chassis
                  weight — and leaves the other four for the operator, because nobody has
                  declared them. Every field below stays visible, editable and required
                  whether a preset was used or not; a preset is a shortcut for typing,
                  never a substitute for a declaration.
                */}
                <div className="mb-6 rounded-xl border border-border/60 bg-muted/30 p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                    <div>
                      <Label className="block">Simulation preset (optional)</Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Fills mass, normal speed and payload capacity. The remaining four
                        values are not declared for these presets and stay yours to enter.
                      </p>
                    </div>
                    {appliedPreset ? (
                      <Badge variant="secondary">{appliedPreset} applied</Badge>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {SIMULATION_PRESETS.map((preset) => (
                      <Button
                        key={preset.name}
                        type="button"
                        size="sm"
                        variant={appliedPreset === preset.name ? 'default' : 'outline'}
                        onClick={() => applyPreset(preset)}
                        title={preset.hint}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>

                  <p className="mt-3 text-xs text-muted-foreground">
                    Declared development-simulation figures, not measurements.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {SPECIFICATION_FIELDS.map((field) => (
                    <div key={field.key}>
                      <Label htmlFor={`sim-spec-${field.key}`} className="mb-2 block">
                        {field.label}{' '}
                        <span className="text-muted-foreground font-normal">({field.unit})</span>
                      </Label>
                      <Input
                        id={`sim-spec-${field.key}`}
                        type="number"
                        inputMode="decimal"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={spec[field.key]}
                        onChange={(e) => setSpecField(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        required
                        autoComplete="off"
                        className="font-mono"
                      />
                      {/*
                        Shown only once a preset has been applied, and only for the fields
                        it deliberately did not fill. Without it an operator who pressed
                        "Light" and saw four boxes still empty would reasonably conclude
                        the button was broken. Naming the reason is the difference between
                        an omission and a stated absence.
                      */}
                      {appliedPreset && PRESET_UNDECLARED[field.key] ? (
                        <div className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                          Not declared by the preset. {PRESET_UNDECLARED[field.key]}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="mt-6 border-t border-border/60 pt-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    <div>
                      <Label htmlFor="sim-spec-initialBatteryPct" className="mb-2 block">
                        {INITIAL_BATTERY_FIELD.label}{' '}
                        <span className="text-muted-foreground font-normal">
                          ({INITIAL_BATTERY_FIELD.unit})
                        </span>
                      </Label>
                      <Input
                        id="sim-spec-initialBatteryPct"
                        type="number"
                        inputMode="decimal"
                        min={INITIAL_BATTERY_FIELD.min}
                        max={INITIAL_BATTERY_FIELD.max}
                        step={INITIAL_BATTERY_FIELD.step}
                        value={spec[INITIAL_BATTERY_FIELD.key]}
                        onChange={(e) => setSpecField(INITIAL_BATTERY_FIELD.key, e.target.value)}
                        placeholder={INITIAL_BATTERY_FIELD.placeholder}
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
                        This is the state of charge the unit is declared to start at.
                      </div>
                    </div>
                  </div>
                </div>

                {formError ? (
                  <div
                    role="alert"
                    className="mt-6 rounded-lg bg-destructive/10 text-destructive px-4 py-3 text-sm font-medium"
                  >
                    {formError}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </form>
        </div>

        <aside className="lg:col-span-1">
          <Card className="rounded-2xl border border-border/60 shadow-sm bg-muted/40">
            <CardHeader className="p-6">
              <CardTitle className="text-lg font-medium">About simulated units</CardTitle>
              <CardDescription>What this creates, and what it does not.</CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0">
              <div className="text-sm text-muted-foreground space-y-4">
                <p>
                  A simulated unit is a real robot record that no hardware will ever claim.
                  It is dispatched by the same assignment engine as the physical fleet, with
                  no special handling of any kind.
                </p>

                <div>
                  <div className="text-sm font-medium text-foreground">One per submission</div>
                  <p className="mt-2">
                    Each submission creates exactly one unit, and there is no limit on how
                    many you may create — submit again for the next one. There is no field
                    for a number of robots, because the server has no way to be asked for
                    several at once.
                  </p>
                </div>

                <div>
                  <div className="text-sm font-medium text-foreground">Created is not running</div>
                  <p className="mt-2">
                    Creating the unit writes the record. Whether a simulator process is
                    actually driving it is reported separately, and is{' '}
                    <span className="font-mono">PERSISTED_NOT_RUNNING</span> whenever the
                    simulator is disabled for this deployment.
                  </p>
                </div>

                <div>
                  <div className="text-sm font-medium text-foreground">Not hardware</div>
                  <p className="mt-2">
                    Physical units are registered separately through Commission Unit, which
                    issues a pairing code. Nothing here mints one.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
