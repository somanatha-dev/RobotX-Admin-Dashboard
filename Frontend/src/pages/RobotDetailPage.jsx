import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Camera, CheckCircle2, KeyRound, Pencil, PlugZap, Trash2, X } from 'lucide-react';
import { useAppActions, useAppState } from '@/context/appContext.js';
import useRobotCommand from '@/hooks/useRobotCommand.js';
import { RESUME_UNAVAILABLE_REASON, returnAvailability } from '@/lib/robotCommands.js';
import { RobotIdentityBadge, SimulatorRuntimeBadge } from '@/components/system/RobotIdentity.jsx';
import {
  identityOf,
  isSimulated,
  runtimeLabel,
  runtimeReason,
  runtimeStatusOf,
} from '@/lib/simulationIdentity.js';
import { normalizeStatus, isActive, isIdle } from '@/lib/robotStatus.js';
import * as robotsApi from '@/lib/api/robots.js';
import { connectActionFor, connectPathFor } from '@/lib/robotEnrollment.js';
import { isSuperAdmin, mayCommand, mayReadSimulator, SIMULATOR_RESTRICTED_NOTE } from '@/lib/access.js';
import {
  CHASSIS_LABEL,
  CHASSIS_OPTIONS,
  SPECIFICATION_FIELDS,
  formatSpecValue,
  hasSpecification,
  validateSpecification,
} from '@/lib/robotSpecification.js';

/** The edit form's initial values, read from what is stored. */
function draftFrom(specification) {
  const draft = Object.fromEntries(
    SPECIFICATION_FIELDS.map((field) => [
      field.key,
      typeof specification?.[field.key] === 'number' ? String(specification[field.key]) : '',
    ]),
  );
  draft.chassisType = specification?.chassisType || CHASSIS_OPTIONS[0].value;
  return draft;
}

export default function RobotDetailPage() {
  const { robots, tasks, simulatorStatus, session } = useAppState();
  // RBAC — offers only; the server refuses these to a campus administrator regardless.
  const superAdmin = isSuperAdmin(session);
  const mayReturn = mayCommand(session, 'RETURN');
  const { retire, updateRobotSpecification } = useAppActions();
  const navigate = useNavigate();
  const { id } = useParams();
  const sendCommand = useRobotCommand();

  const robot = robots.find((r) => r.robotId === id);
  const specification = robot?.specification || null;
  // FS-05 — RETURN is not offered while the backend says this unit holds a task.
  const returnState = returnAvailability(robot, tasks);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(specification));
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Enrollment, for a physical unit that is offline: "Connect" if it has never paired,
  // "Re-pair" if it has. One read when the page opens or the unit goes offline. The
  // pairing status never carries the code, and nothing here issues one: both buttons lead to
  // the Connect page, where issuing a code is confirmed and step-up authorised.
  const [pairingStatus, setPairingStatus] = useState(null);
  const robotCode = robot?.robotId;
  // Enrollment is a super administrator's: a campus administrator is not offered it, so its
  // pairing status (a SUPER_ADMIN-only read) is not requested.
  const needsPairingStatus = superAdmin && Boolean(robot) && !isSimulated(robot) && robot.isOnline !== true;
  useEffect(() => {
    if (!needsPairingStatus || !robotCode) return undefined;
    let cancelled = false;
    robotsApi
      .getPairingStatus(robotCode)
      .then((next) => {
        if (!cancelled) setPairingStatus(next);
      })
      .catch(() => {
        if (!cancelled) setPairingStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [needsPairingStatus, robotCode]);
  const connectAction = superAdmin ? connectActionFor(robot, pairingStatus) : null;

  // Re-seed the draft when the stored specification changes underneath the form — an edit
  // made in another session, or the first load arriving after this page mounted. Skipped
  // while editing, so a live update never overwrites what the operator is typing.
  useEffect(() => {
    if (!isEditing) setDraft(draftFrom(specification));
  }, [specification, isEditing]);

  const handleSave = async () => {
    setSaveError('');

    const validated = validateSpecification(draft);
    if (!validated.ok) {
      setSaveError(validated.problems.join(' '));
      return;
    }

    setIsSaving(true);
    try {
      // Only the configuration fields. The endpoint refuses anything else by name, and
      // sending a rendered telemetry value here would be an operator asserting a reading.
      await updateRobotSpecification(robot.robotId, {
        chassisType: draft.chassisType,
        ...validated.values,
      });
      setIsEditing(false);
    } catch (e) {
      setSaveError(e?.message || 'Could not save the configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!robot && robots.length === 0) {
    return <div className="p-8 text-center font-bold text-slate-500">Loading unit…</div>;
  }

  if (!robot) {
    return (
      <div className="p-8 text-center font-bold text-slate-500" data-robot-unavailable>
        {/* RBAC — the same sentence whether the unit does not exist, was retired, or belongs to
            another campus: the list this page reads is already scoped, so it cannot tell which,
            and must not suggest one. */}
        {superAdmin
          ? 'Robot not found. It may have been retired or removed.'
          : 'This robot is not available. It may not exist, may have been retired, or may be outside your campus.'}
        <button onClick={() => navigate('/robots')} className="text-blue-500 underline ml-2">
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-slate-50">
      {/* Sticky under the top bar from `md` up; on a phone the header (with its 2×2 command
          grid) scrolls away rather than holding a third of the screen. */}
      <div className="md:sticky md:top-16 z-10 bg-white border-b border-slate-200 px-3 py-3 lg:px-6 lg:py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-4 shadow-sm">
        <div className="flex items-start sm:items-center gap-2 sm:gap-4 min-w-0">
          <button
            type="button"
            onClick={() => navigate('/robots')}
            aria-label="Back to robots"
            className="shrink-0 p-2 hover:bg-slate-100 rounded-lg text-slate-500 transition-colors border border-transparent hover:border-slate-200"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-x-2 gap-y-1.5 sm:gap-x-3 flex-wrap">
              <h1 className="text-lg sm:text-xl font-bold font-mono text-slate-900 tracking-tight break-all">{robot.robotId}</h1>
              <span
                className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${
                  isActive(robot.status)
                    ? 'bg-emerald-100 text-emerald-700'
                    : isIdle(robot.status)
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-rose-100 text-rose-700'
                }`}
              >
                {normalizeStatus(robot.status)}
              </span>
              <RobotIdentityBadge robot={robot} />
              <SimulatorRuntimeBadge robot={robot} simulatorStatus={simulatorStatus} restricted={!superAdmin} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3 shrink-0">
          {/* Not sent in V1: the backend refuses a unit's own return to service (§23.5),
              so RESUME is delivered and changes nothing. Shown disabled with the reason
              rather than removed, so the operator learns why a paused unit stays paused. */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            title={RESUME_UNAVAILABLE_REASON}
            data-command-unavailable="RESUME"
            className="flex-1 sm:flex-none bg-slate-100 border border-slate-200 text-slate-400 px-4 py-2.5 rounded-lg text-xs font-bold shadow-sm cursor-not-allowed"
          >
            RESUME (N/A IN V1)
          </button>
          {/* FS-05: RETURN bypasses the engine and abandons a delivery, so it is not
              offered while the unit holds a task; otherwise it carries its warning.
              RBAC: not offered to a campus administrator (STOP and PAUSE only). */}
          {mayReturn ? (
          <button
            type="button"
            onClick={() => sendCommand(robot.robotId, 'RETURN')}
            disabled={!returnState.available}
            aria-disabled={!returnState.available}
            title={returnState.reason || undefined}
            data-command-unavailable={returnState.available ? undefined : 'RETURN'}
            className={`flex-1 sm:flex-none border px-4 py-2.5 rounded-lg text-xs font-bold transition-colors shadow-sm ${
              returnState.available
                ? 'bg-white border-slate-300 hover:bg-slate-50 text-slate-700'
                : 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            RETURN
          </button>
          ) : null}
          <button
            onClick={() => sendCommand(robot.robotId, 'STOP')}
            className="flex-1 sm:flex-none bg-amber-500 hover:bg-amber-600 text-white px-6 py-2.5 rounded-lg text-xs font-bold tracking-widest transition-colors shadow-sm"
          >
            STOP
          </button>
          {superAdmin ? (
          <>
          <div className="w-px h-8 bg-slate-300 mx-1 self-center hidden sm:block" />
          <button
            onClick={() => retire(robot.robotId)}
            className="flex-1 sm:flex-none bg-rose-600 hover:bg-rose-700 text-white px-4 py-2.5 rounded-lg text-xs font-bold transition-colors shadow-sm flex items-center justify-center gap-1.5"
            title="Permanently Remove Unit"
          >
            <Trash2 className="w-4 h-4" /> RETIRE
          </button>
          </>
          ) : null}
        </div>
      </div>

      {connectAction ? (
        <div
          role="note"
          data-connect-action={connectAction.kind}
          className="mx-3 sm:mx-4 lg:mx-6 mt-3 sm:mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm"
        >
          <span className="text-slate-700">
            {connectAction.kind === 'repair'
              ? 'Offline. This robot is enrolled and reconnects by itself when its Pi is powered on and online. Re-pair only if it has lost its stored credential.'
              : 'This physical robot has not connected yet. Pair its Pi to bring it online.'}
          </span>
          <button
            type="button"
            onClick={() => navigate(connectPathFor(robot.robotId))}
            className="shrink-0 inline-flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-xs font-bold"
          >
            {connectAction.kind === 'repair' ? <KeyRound className="w-4 h-4" /> : <PlugZap className="w-4 h-4" />}
            {connectAction.label}
          </button>
        </div>
      ) : !isSimulated(robot) && robot.isOnline === true ? (
        <div
          role="note"
          data-connect-action="connected"
          className="mx-3 sm:mx-4 lg:mx-6 mt-3 sm:mt-4 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-900 flex items-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4" /> Connected. Last seen{' '}
          {robot.lastSeenAt ? new Date(robot.lastSeenAt).toLocaleString() : '—'}.
        </div>
      ) : null}

      {normalizeStatus(robot.status) === 'PAUSED' && (
        <div
          role="note"
          data-paused-note
          className="mx-3 sm:mx-4 lg:mx-6 mt-3 sm:mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-900"
        >
          This unit is PAUSED and out of assignment. {RESUME_UNAVAILABLE_REASON}
        </div>
      )}

      <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="space-y-4 sm:space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <span className="text-sm font-bold text-slate-800 uppercase tracking-widest flex items-center gap-2">
                <Camera className="w-4 h-4 text-slate-400" /> Primary Vision
              </span>
            </div>
            <div className="relative aspect-video bg-slate-900 flex items-center justify-center overflow-hidden">
              <div className="text-slate-400 text-sm font-semibold">No camera stream configured</div>
            </div>
          </div>
        </div>

        <div className="space-y-4 sm:space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Live State</h3>
            <div className="space-y-5">
              <div>
                <div className="flex justify-between items-end mb-2">
                  <span className="text-sm font-medium text-slate-600">Battery</span>
                  <span className="font-mono font-bold text-slate-900 text-lg">{Number(robot.battery || 0).toFixed(1)}%</span>
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                  <div
                    className={`h-full ${(Number(robot.battery) || 0) < 25 ? 'bg-rose-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Number(robot.battery || 0)}%` }}
                  />
                </div>
              </div>
              <div className="h-px bg-slate-100 w-full" />
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Current Speed</div>
                  <div className="font-mono text-2xl font-bold text-slate-900">
                    {robot.speed ?? '—'} {robot.speed == null ? null : <span className="text-sm text-slate-500 font-sans">m/s</span>}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Movement</div>
                  <div className="font-semibold text-slate-700 mt-1">{(Number(robot.speed) || 0) > 0 ? 'Moving' : 'Stationary'}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Unit Info</h3>
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3 text-sm shadow-sm">
              {/* ── Three rows that are deliberately three rows ─────────────
                  Type is what the unit IS. Online is whether it currently holds an
                  authenticated session — reported by the fleet, identical for a
                  simulated agent and for hardware. Simulator runtime is whether a
                  simulator process is driving this record at all, and it exists only for
                  a simulated unit. None of the three is derived from either of the
                  others; a simulated robot with the simulator disabled is
                  PERSISTED_NOT_RUNNING and offline, and that is the honest reading. */}
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Type</span>
                <span className="font-mono font-bold text-slate-700">{identityOf(robot)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Online</span>
                <span className={`font-mono font-bold ${robot.isOnline ? 'text-emerald-600' : 'text-slate-500'}`}>{robot.isOnline ? 'YES' : 'NO'}</span>
              </div>
              {isSimulated(robot) ? (
                <div className="flex justify-between items-start gap-3">
                  <span className="text-slate-500 font-medium shrink-0">Simulator runtime</span>
                  <span className="text-right min-w-0">
                    <span className="font-mono font-bold text-slate-700 wrap-anywhere">
                      {mayReadSimulator(session) ? runtimeLabel(runtimeStatusOf(robot, simulatorStatus)) : 'Restricted'}
                    </span>
                    {!mayReadSimulator(session) ? (
                      <span className="block text-[11px] font-normal text-slate-500 mt-0.5 max-w-64" data-simulator-restricted>{SIMULATOR_RESTRICTED_NOTE}</span>
                    ) : runtimeReason(runtimeStatusOf(robot, simulatorStatus), simulatorStatus, robot) ? (
                      <span className="block text-[11px] font-normal text-slate-500 mt-0.5 max-w-64">
                        {runtimeReason(runtimeStatusOf(robot, simulatorStatus), simulatorStatus, robot)}
                      </span>
                    ) : null}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between items-start gap-3">
                <span className="text-slate-500 font-medium shrink-0">Last Seen</span>
                <span className="font-mono font-bold text-slate-700 text-right">{robot.lastSeenAt ? new Date(robot.lastSeenAt).toLocaleString() : '—'}</span>
              </div>
              <div className="flex justify-between items-start gap-3">
                <span className="text-slate-500 font-medium shrink-0">Location</span>
                <span className="font-mono font-bold text-slate-700 text-right min-w-0 wrap-anywhere">{robot.location?.name || '—'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Task</span>
                <span className="font-mono font-bold text-blue-600">{robot.currentTask?.taskId || 'None'}</span>
              </div>
            </div>
          </div>

          {/* ── Configuration ──────────────────────────────────────────────────
              What was entered at commissioning, kept visually apart from the live
              state above because none of it is a reading. Editing writes only these
              fields; the endpoint refuses any other by name. */}
          <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                Configuration
              </h3>
              {isEditing ? (
                <button
                  onClick={() => { setIsEditing(false); setSaveError(''); setDraft(draftFrom(specification)); }}
                  className="text-xs font-semibold text-slate-500 hover:text-slate-800 flex items-center gap-1"
                >
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
              ) : superAdmin ? (
                // RBAC — configuration edits are a super administrator's.
                <button
                  onClick={() => { setIsEditing(true); setDraft(draftFrom(specification)); }}
                  className="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
              ) : null}
            </div>

            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <label htmlFor="edit-chassis" className="block text-xs font-medium text-slate-600 mb-1.5">
                    Model
                  </label>
                  <select
                    id="edit-chassis"
                    value={draft.chassisType}
                    onChange={(e) => { setSaveError(''); setDraft((d) => ({ ...d, chassisType: e.target.value })); }}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  >
                    {CHASSIS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {SPECIFICATION_FIELDS.map((field) => (
                    <div key={field.key}>
                      <label htmlFor={`edit-${field.key}`} className="block text-xs font-medium text-slate-600 mb-1.5">
                        {field.label} <span className="text-slate-400 font-normal">({field.unit})</span>
                      </label>
                      <input
                        id={`edit-${field.key}`}
                        type="number"
                        inputMode="decimal"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={draft[field.key]}
                        onChange={(e) => { setSaveError(''); setDraft((d) => ({ ...d, [field.key]: e.target.value })); }}
                        placeholder={field.placeholder}
                        className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                      />
                    </div>
                  ))}
                </div>

                {saveError ? (
                  <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 text-xs font-medium">
                    {saveError}
                  </div>
                ) : null}

                <div className="text-[10px] text-slate-500">
                  Battery level, position and the current assignment are not editable here:
                  the first two are reported by the unit and the third is the assignment
                  engine&apos;s.
                </div>

                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="w-full bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white py-2.5 rounded-lg text-xs font-bold transition-colors shadow-sm"
                >
                  {isSaving ? 'SAVING…' : 'SAVE CONFIGURATION'}
                </button>
              </div>
            ) : (
              <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3 text-sm shadow-sm">
                <div className="flex justify-between items-center">
                  <span className="text-slate-500 font-medium">Model</span>
                  <span className="font-bold text-slate-700">
                    {CHASSIS_LABEL[specification?.chassisType] || '—'}
                  </span>
                </div>
                {SPECIFICATION_FIELDS.map((field) => (
                  <div key={field.key} className="flex justify-between items-center">
                    <span className="text-slate-500 font-medium">{field.label}</span>
                    <span className="font-mono font-bold text-slate-700">
                      {formatSpecValue(specification?.[field.key], field.unit)}
                    </span>
                  </div>
                ))}
                {!hasSpecification(specification) ? (
                  <div className="text-xs text-slate-500 pt-1">
                    No specification recorded for this unit — it was commissioned before the
                    configuration was collected. Use <span className="font-semibold">Edit</span> to enter one.
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
