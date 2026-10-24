import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, Ban, Navigation, OctagonX } from 'lucide-react';

import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.jsx';
import { submitObstacleDecision } from '@/lib/api/dtaro.js';
import { newIdempotencyKey } from '@/lib/idempotency.js';
import {
  AFFECTED_TEXT,
  CHOICE,
  CHOICE_TEXT,
  EXECUTION_TEXT,
  ROBOT_STATE_TEXT,
  STATUS_TEXT,
  SOURCE,
  clockOf,
  countdownSeconds,
  decisionLine,
  isAwaiting,
  nextAwaiting,
  obstacleDecisionStore,
  remainingMs,
} from '@/lib/obstacleDecision.js';

/**
 * DTARO operator decision panel — STOP, REROUTE or REJECT_BROADCAST for an obstacle a SIMULATED
 * robot reported. Opened only by the server's `OBSTACLE_DECISION_REQUIRED` (or its replay on
 * reconnect); every field is the server's, and an absent one says "Unavailable". The countdown is
 * the server's deadline as the server's clock has it: the SERVER applies REROUTE when it passes,
 * whether or not this page is open, so closing the panel decides nothing.
 *
 * The information-only obstacle modal (`DecisionRequiredModal`, FS-06) is unchanged and still
 * serves alerts delivered without a decision step.
 */

const UNAVAILABLE = 'Unavailable';

const ACTIONS = [
  { choice: CHOICE.STOP, icon: OctagonX, variant: 'destructive', hint: 'Stop every affected simulated robot' },
  { choice: CHOICE.REROUTE, icon: Navigation, variant: 'default', hint: 'Detour affected robots around it (server default)' },
  { choice: CHOICE.REJECT_BROADCAST, icon: Ban, variant: 'outline', hint: 'Suppress the fleet alert; stop only the reporter if it is heading into it' },
];

/** What the server said when it refused this page's request, in words. */
const REFUSAL_TEXT = Object.freeze({
  DEADLINE_PASSED: "Too late: the server's deadline passed and it applied its default.",
  DEFAULT_ALREADY_APPLIED: 'The server already applied its default.',
  ALREADY_DECIDED: 'Another decision was committed first.',
  NOT_AWAITING_DECISION: 'This decision is no longer waiting for an operator.',
  UNKNOWN_DECISION: 'The server no longer holds this decision (it may have restarted).',
  OPERATOR_DECISIONS_DISABLED: 'Operator decisions are switched off on the server.',
  NETWORK: 'Not sent: no connection to the server. Try again — the same request is safe to repeat.',
});

const coordinate = (p) => (p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}` : UNAVAILABLE);
const place = (p) => (p ? `${p.name || UNAVAILABLE}${Number.isFinite(p.lat) ? ` (${p.lat.toFixed(5)}, ${p.lon.toFixed(5)})` : ''}` : UNAVAILABLE);
const percent = (fraction) => (Number.isFinite(fraction) ? `${Math.round(fraction * 100)} %` : UNAVAILABLE);
const stateText = (robot) => (robot?.state ? ROBOT_STATE_TEXT[robot.state] || robot.state.toLowerCase() : UNAVAILABLE);

function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-muted-foreground text-[11px] uppercase tracking-wide">{label}</dt>
      <dd className="font-medium text-foreground wrap-break-word">{children}</dd>
    </div>
  );
}

function plannedAction(robot, decision) {
  if (robot.execution) {
    const progress = robot.execution.progress ? ` · ${percent(robot.execution.progress.fraction)}` : '';
    return `${EXECUTION_TEXT[robot.execution.state] || robot.execution.state}${progress}`;
  }
  if (decision?.decision) return 'No instruction';
  if (!robot.preview) return 'Reroute: checking for a safe alternate route…';
  return robot.preview.ok
    ? `Reroute: alternate route available (${robot.preview.distanceM} m)`
    : 'Reroute: no safe alternate route available — it would be stopped';
}

function AffectedRobot({ robot, decision }) {
  const sim = robot.provenance === 'SIMULATED';
  return (
    <li className="rounded-lg border border-border/60 p-2.5" data-affected-robot={robot.robotId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{robot.name || robot.robotId}</span>
        {robot.name && <span className="font-mono text-xs text-muted-foreground">{robot.robotId}</span>}
        {sim && <Badge variant="secondary" className="text-[10px]">SIMULATED</Badge>}
        {robot.role === 'REPORTER' && <Badge variant="outline" className="text-[10px]">reporter</Badge>}
        <span className="text-xs text-muted-foreground">{stateText(robot)}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Why: {AFFECTED_TEXT[robot.affectedReason] || robot.affectedReason || UNAVAILABLE}</p>
      <p className="mt-0.5 text-xs">
        {place(robot.origin)} → {place(robot.destination)}
        {robot.routeProgress ? <span className="text-muted-foreground"> · route {percent(robot.routeProgress.fraction)} done</span> : null}
      </p>
      <p className="mt-0.5 text-xs font-medium" data-robot-action>{plannedAction(robot, decision)}</p>
      {robot.execution?.robotReason && <p className="mt-0.5 text-[11px] text-muted-foreground">Robot reports: {robot.execution.robotReason}</p>}
    </li>
  );
}

/**
 * The panel's content. Pure: rendered by the dialog below and, in tests, on its own.
 *
 * @param {object} props
 * @param {object} props.decision        a decision from `obstacleDecisionStore`
 * @param {number} props.nowMs           this page's clock
 * @param {number} props.offsetMs        the server's clock minus this page's
 * @param {string|null} props.submitting the choice being sent, or null
 * @param {string|null} props.message    the outcome of this page's request, or null
 * @param {number} [props.others]        further decisions awaiting an operator
 * @param {(choice: string) => void} props.onDecide
 * @param {() => void} props.onClose
 */
export function ObstacleDecisionCard({ decision, nowMs, offsetMs, submitting = null, message = null, others = 0, onDecide, onClose }) {
  const awaiting = isAwaiting(decision);
  const left = remainingMs(decision, nowMs, offsetMs);
  const seconds = countdownSeconds(decision, nowMs, offsetMs);
  const windowMs = decision.windowMs || 5000;
  const obstacle = decision.obstacle || {};
  const reporter = decision.reporter || {};
  const affected = (decision.robots || []).filter((r) => r.affected === true);
  const notAffected = (decision.robots || []).filter((r) => r.affected !== true);
  const committed = decision.decision;
  const propagation = decision.propagation;
  const canDecide = awaiting && left > 0 && !submitting;
  const titleId = `obstacle-decision-title-${decision.decisionId}`;
  const countdownId = `obstacle-decision-countdown-${decision.decisionId}`;

  return (
    <div className="space-y-4" data-obstacle-decision={decision.decisionId} data-status={decision.status}>
      <div className="flex flex-wrap items-center gap-2 pr-6">
        <Badge variant="destructive" className="gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          {awaiting ? 'OBSTACLE — DECISION REQUIRED' : 'OBSTACLE DECISION'}
        </Badge>
        <Badge variant="secondary" data-simulated>SIMULATED</Badge>
        {others > 0 && <span className="text-xs text-muted-foreground">+{others} more awaiting</span>}
      </div>
      <h2 id={titleId} className="text-base font-semibold leading-snug">
        Obstacle reported by {reporter.name || reporter.robotId || UNAVAILABLE}
        <span className="block text-xs font-normal text-muted-foreground">{STATUS_TEXT[decision.status] || decision.status}</span>
      </h2>

      {awaiting ? (
        // Plain amber on the card, as the information-only obstacle modal uses: the countdown is the
        // one element that must read at a glance (dark: variants washed it out on the light card).
        <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-amber-950">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold">Decide within</span>
            <span id={countdownId} role="timer" aria-live="off" aria-atomic="true" className="text-3xl font-bold tabular-nums text-amber-950" data-countdown={seconds}>
              {seconds}&nbsp;s
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-amber-200" aria-hidden="true">
            <div className="h-full bg-amber-600 transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, (left / windowMs) * 100))}%` }} />
          </div>
          <p className="mt-2 text-xs">
            The server applies <strong>{CHOICE_TEXT[decision.defaultDecision] || 'Reroute'}</strong> at{' '}
            {clockOf(decision.deadlineAtMs) || UNAVAILABLE} if no decision reaches it first — whether or not this page is open.
          </p>
        </div>
      ) : committed ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3" role="status" data-decision-outcome={committed.choice} data-decision-source={committed.source}>
          <p className="text-sm font-semibold">{decisionLine(decision)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {committed.source === SOURCE.MANUAL ? 'Manual' : 'Automatic'} · committed {clockOf(Date.parse(committed.decidedAt)) || UNAVAILABLE}
            {committed.reason ? ` · ${committed.reason}` : ''}
          </p>
          {propagation && (
            <p className="mt-1 text-xs" data-propagation={propagation.outcome}>
              {propagation.outcome === 'SUPPRESSED'
                ? `Broadcast rejected — fleet alert suppressed for ${propagation.suppressedRecipients?.length || 0} robot(s)${propagation.suppressedRecipients?.length ? `: ${propagation.suppressedRecipients.join(', ')}` : ''}. The obstacle is not confirmed absent.`
                : propagation.outcome === 'PROPAGATED'
                  ? `Fleet alert delivered to ${propagation.delivered?.length || 0} robot(s)${propagation.delivered?.length ? `: ${propagation.delivered.join(', ')}` : ''}.`
                  : `Fleet alert not delivered: ${propagation.reason || UNAVAILABLE}.`}
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm" role="status">
          {decision.abandonedReason || STATUS_TEXT[decision.status] || decision.status}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Decision" aria-describedby={awaiting ? countdownId : undefined}>
        {ACTIONS.map(({ choice, icon, variant, hint }) => {
          const chosen = committed?.choice === choice;
          return (
            <Button
              key={choice}
              type="button"
              variant={chosen ? 'default' : variant}
              className="h-auto min-h-11 flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left"
              disabled={!canDecide}
              aria-pressed={chosen}
              onClick={() => onDecide(choice)}
              data-decision-action={choice}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                {React.createElement(icon, { className: 'h-4 w-4', 'aria-hidden': 'true' })}
                {CHOICE_TEXT[choice]}
                {submitting === choice ? '…' : ''}
              </span>
              <span className="text-[11px] font-normal opacity-80">{hint}</span>
            </Button>
          );
        })}
      </div>
      {message && (
        <p role="alert" className="text-xs font-medium text-destructive" data-decision-message>
          {message}
        </p>
      )}

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-lg border border-border/60 p-3 text-sm sm:grid-cols-2">
        <Field label="Obstacle">
          <span className="font-mono text-xs">{obstacle.obstacleId || UNAVAILABLE}</span>
        </Field>
        <Field label="Decision status">{STATUS_TEXT[decision.status] || decision.status}</Field>
        <Field label="Reporting robot">
          {reporter.name ? `${reporter.name} (${reporter.robotId})` : reporter.robotId || UNAVAILABLE} · SIMULATED
        </Field>
        <Field label="Reporter state">{stateText(reporter)}</Field>
        <Field label="Reporter position">{coordinate(reporter.position)}</Field>
        <Field label="Reporter route">
          {reporter.routeProgress ? `${percent(reporter.routeProgress.fraction)} of ${reporter.routeProgress.totalM} m` : UNAVAILABLE}
        </Field>
        <Field label="Origin">{place(reporter.origin)}</Field>
        <Field label="Destination">{place(reporter.destination)}</Field>
        <Field label="Obstacle location">{coordinate(obstacle)}</Field>
        <Field label="Published cell">
          <span className="font-mono text-xs">{obstacle.cellId || UNAVAILABLE}</span>
        </Field>
        <Field label="Zone · region">{[obstacle.zoneId, obstacle.regionId].filter(Boolean).join(' · ') || UNAVAILABLE}</Field>
        <Field label="Severity">{obstacle.severity ? `${obstacle.severity.toLowerCase()} (as reported, advisory)` : UNAVAILABLE}</Field>
        <Field label="Detection">
          {obstacle.detection?.source === 'SIMULATED_ROBOT_REPORT' ? 'Simulated robot report' : UNAVAILABLE} · confidence{' '}
          {Number.isFinite(obstacle.detection?.confidence) ? obstacle.detection.confidence : UNAVAILABLE}
        </Field>
        <Field label="Received by the server">{clockOf(decision.receivedAtMs) || UNAVAILABLE}</Field>
        {obstacle.corroborations?.length > 0 && (
          <Field label="Also reported by" wide>
            {obstacle.corroborations.join(', ')} (same published cell, merged)
          </Field>
        )}
      </dl>

      <section aria-label="Potentially affected robots">
        <h3 className="mb-1.5 text-sm font-semibold">
          Potentially affected: {affected.length} robot{affected.length === 1 ? '' : 's'}
        </h3>
        {affected.length === 0 ? (
          <p className="text-xs text-muted-foreground">No simulated robot's remaining route meets the obstacle.</p>
        ) : (
          <ul className="space-y-2">
            {affected.map((robot) => (
              <AffectedRobot key={robot.robotId} robot={robot} decision={decision} />
            ))}
          </ul>
        )}
        {notAffected.length > 0 && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Considered, not affected ({notAffected.length})</summary>
            <ul className="mt-1 space-y-1">
              {notAffected.map((r) => (
                <li key={r.robotId}>
                  <span className="font-mono">{r.robotId}</span> — {AFFECTED_TEXT[r.affectedReason] || r.affectedReason}
                  {r.alertedOnPropagation ? ' (alerted, no instruction)' : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        Simulation only: only simulated robots receive these instructions, and the commanded route the assignment engine issued
        is never changed — an alternate route is driven by the simulator alone. No physical robot is involved.
      </p>

      <Button type="button" variant="outline" className="w-full" onClick={onClose} data-decision-close>
        {awaiting ? 'Close — the server still decides at the deadline' : 'Close'}
      </Button>
    </div>
  );
}

/** The dialog: opens on the server's awaiting decision, keeps its outcome on screen until closed. */
export default function ObstacleDecisionPanel() {
  const state = useSyncExternalStore(obstacleDecisionStore.subscribe, obstacleDecisionStore.getSnapshot);
  const [setAside, setSetAside] = useState(() => new Set());
  const [focusId, setFocusId] = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [messages, setMessages] = useState({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  // One key per decision for this page: a retried click is the same request to the server.
  const keys = useRef(new Map());

  const next = useMemo(() => nextAwaiting(state, { setAside }), [state, setAside]);
  const focused = focusId ? state.decisions.find((d) => d.decisionId === focusId) || null : null;
  // A new awaiting decision takes the panel when nothing is on it (adjusted during render, so no
  // frame shows the panel without it).
  if (!focused && next.decision && focusId !== next.decision.decisionId) setFocusId(next.decision.decisionId);
  const decision = focused || next.decision;
  const awaiting = isAwaiting(decision);

  useEffect(() => {
    if (!awaiting) return undefined;
    // Re-read the clock at once (the panel may have opened long after this component mounted),
    // then a few times a second. The countdown is display only; the server holds the deadline.
    const first = setTimeout(() => setNowMs(Date.now()), 0);
    const timer = setInterval(() => setNowMs(Date.now()), 200);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [awaiting, decision?.decisionId]);

  const onDecide = useCallback(
    async (choice) => {
      if (!decision || submitting) return;
      const id = decision.decisionId;
      if (!keys.current.has(id)) keys.current.set(id, newIdempotencyKey());
      setSubmitting(choice);
      setMessages((m) => ({ ...m, [id]: null }));
      const result = await submitObstacleDecision(id, choice, keys.current.get(id));
      if (result.decision) obstacleDecisionStore.apply(result.decision, Date.now());
      if (!result.ok) {
        const committedText = result.committed ? ` Committed: ${CHOICE_TEXT[result.committed.choice] || result.committed.choice}.` : '';
        setMessages((m) => ({ ...m, [id]: `${REFUSAL_TEXT[result.error] || `Not accepted (${result.error}).`}${committedText}` }));
      }
      setSubmitting(null);
    },
    [decision, submitting]
  );

  const onClose = useCallback(() => {
    if (!decision) return;
    const id = decision.decisionId;
    setSetAside((prev) => new Set(prev).add(id));
    setFocusId(null);
  }, [decision]);

  if (!decision) return null;
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        role="alertdialog"
        aria-describedby={undefined}
        className="max-h-[92vh] max-w-2xl overflow-y-auto p-4 sm:p-5"
        data-obstacle-decision-dialog
      >
        <DialogTitle className="sr-only">Obstacle decision</DialogTitle>
        <ObstacleDecisionCard
          decision={decision}
          nowMs={nowMs}
          offsetMs={state.offsetMs}
          submitting={submitting}
          message={messages[decision.decisionId] || null}
          others={next.decision && next.decision.decisionId !== decision.decisionId ? next.others + 1 : next.others}
          onDecide={onDecide}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
