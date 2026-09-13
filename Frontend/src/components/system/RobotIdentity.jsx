import React from 'react';

import { Badge } from '@/components/ui/badge.jsx';
import {
  IDENTITY,
  RUNTIME,
  identityOf,
  isSimulated,
  runtimeLabel,
  runtimeReason,
  runtimeStatusOf,
} from '@/lib/simulationIdentity.js';

/**
 * The two badges that say what a unit is, and — for a simulated one — what is currently
 * running it.
 *
 * ── Why one component rather than a span on each page ───────────────────────
 * Three pages identify robots (the Units list, the unit detail page, the dashboard's
 * battery and speed panels). Three copies of "is this simulated" is three places the
 * answer can be written differently, and the difference that matters here is not
 * cosmetic: a unit shown as PHYSICAL that is in fact simulated is a false statement about
 * the fleet. So the rule is in `lib/simulationIdentity.js`, and the rendering is here.
 *
 * ── The text is the signal ──────────────────────────────────────────────────
 * Both badges carry their state as visible words. The variant only tints them, so the
 * distinction survives a monochrome display, a colour-blind reader and a screenshot in a
 * report. Nothing here is conveyed by colour alone.
 */

/** Text + tone for each identity. `UNKNOWN` is shown, not hidden — see `identityOf`. */
const IDENTITY_BADGE = Object.freeze({
  [IDENTITY.SIMULATED]: {
    label: 'SIMULATED',
    variant: 'secondary',
    title: 'A simulated unit. No hardware will ever claim this record.',
  },
  [IDENTITY.PHYSICAL]: {
    label: 'PHYSICAL',
    variant: 'outline',
    title: 'A physical unit, registered through commissioning.',
  },
  [IDENTITY.UNKNOWN]: {
    label: 'TYPE UNKNOWN',
    variant: 'destructive',
    title:
      'This record did not say whether it is simulated. It is not being assumed to be physical.',
  },
});

/**
 * SIMULATED / PHYSICAL, as words.
 *
 * @param {{ robot: object, className?: string }} props
 */
export function RobotIdentityBadge({ robot, className = '' }) {
  const badge = IDENTITY_BADGE[identityOf(robot)] || IDENTITY_BADGE[IDENTITY.UNKNOWN];
  return (
    <Badge variant={badge.variant} className={`text-[10px] px-2 py-0.5 ${className}`} title={badge.title}>
      {badge.label}
    </Badge>
  );
}

const RUNTIME_VARIANT = Object.freeze({
  [RUNTIME.RUNNING]: 'secondary',
  [RUNTIME.PERSISTED_NOT_RUNNING]: 'outline',
  [RUNTIME.UNKNOWN]: 'outline',
});

/**
 * What is currently running a simulated unit — or nothing at all, which is the normal
 * state when the simulator is disabled.
 *
 * Renders nothing for a physical unit: a physical robot has no simulator runtime, and
 * labelling one "not running" would send an operator looking for a simulator that should
 * never exist.
 *
 * This badge is emphatically **not** a liveness indicator. Whether a robot is online is
 * `robot.isOnline`, which the fleet reports by connecting and authenticating — a simulated
 * unit earns it exactly the way hardware does, and neither this badge nor the identity
 * badge above is allowed to stand in for it.
 *
 * @param {{ robot: object, simulatorStatus: object|null, className?: string }} props
 */
export function SimulatorRuntimeBadge({ robot, simulatorStatus, className = '' }) {
  if (!isSimulated(robot)) return null;

  const status = runtimeStatusOf(robot, simulatorStatus);
  // The robot is passed so a held-but-stopped instance is described as one (STEP 4).
  const reason = runtimeReason(status, simulatorStatus, robot);

  return (
    <Badge
      variant={RUNTIME_VARIANT[status] || 'outline'}
      className={`text-[10px] px-2 py-0.5 font-mono ${className}`}
      title={reason || 'A simulator instance is running this unit.'}
    >
      {runtimeLabel(status)}
    </Badge>
  );
}
