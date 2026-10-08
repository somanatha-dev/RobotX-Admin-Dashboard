import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  WifiOff,
} from 'lucide-react';

import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { RobotIdentityBadge } from '@/components/system/RobotIdentity.jsx';
import { useAppActions, useAppState } from '@/context/appContext.js';
import * as robotsApi from '@/lib/api/robots.js';
import { CONNECTION } from '@/lib/connectionState.js';
import { CHASSIS_LABEL } from '@/lib/robotSpecification.js';
import {
  ENROLLMENT_PHASE,
  PAIRING_LOCKOUT_ATTEMPTS,
  PAIRING_LOCKOUT_MINUTES,
  deriveEnrollmentView,
  enrollmentCommand,
  formatCountdown,
  issuedCodeFrom,
} from '@/lib/robotEnrollment.js';

const formatTime = (value) => (value ? new Date(value).toLocaleString() : '—');

/** The checks that cover almost every robot that never shows up. */
function OfflineChecklist({ robotId }) {
  return (
    <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-muted-foreground">
      <li>The Pi is powered on and connected to a network with internet access.</li>
      <li>
        The robot ID configured on the Pi is exactly <span className="font-mono font-semibold text-foreground">{robotId}</span>.
      </li>
      <li>The command ran on the Pi without an error, and within the code’s time limit.</li>
    </ul>
  );
}

function Notice({ tone = 'info', icon: Icon, title, children }) {
  const tones = {
    info: 'border-border/60 bg-muted/40 text-foreground',
    success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    warning: 'border-amber-300 bg-amber-50 text-amber-900',
    danger: 'border-rose-300 bg-rose-50 text-rose-900',
  };
  return (
    <div role="status" className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
      <div className="flex items-center gap-2 font-semibold">
        {Icon ? <Icon className="w-4 h-4 shrink-0" /> : null}
        {title}
      </div>
      {children ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}

/**
 * A second, explicit step before an act that replaces something: a re-pair (which revokes
 * the robot's credential once the new code is used) or a new code (which voids the previous
 * one). The step-up challenge follows only after this is confirmed.
 */
function ConfirmPanel({ title, children, confirmLabel, onConfirm, onCancel }) {
  return (
    <div role="alertdialog" aria-label={title} className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="font-semibold">{title}</div>
      <div className="mt-1.5">{children}</div>
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Keyed by robot, so moving to another robot's Connect page starts from nothing: no code, no
 * status and no confirmation carried over from the previous robot.
 */
export default function ConnectRobotPage() {
  const { id } = useParams();
  const robotId = String(id || '');
  return <ConnectRobot key={robotId} robotId={robotId} />;
}

function ConnectRobot({ robotId }) {
  const navigate = useNavigate();
  const { robots, connection, pairingRejections } = useAppState();
  const { requestAuth, addEvent } = useAppActions();

  const robot = robots.find((r) => r.robotId === robotId);
  const robotsLoaded = robots.length > 0;

  // The code lives here and nowhere else: not in the URL, not in browser storage, not in app
  // state. It is dropped once the robot connects, and with the page when it unmounts.
  const [issued, setIssued] = useState(null); // { code, issuedAtMs, expiresAtMs }
  const [status, setStatus] = useState(null);
  const [statusAtMs, setStatusAtMs] = useState(null);
  const [statusFailed, setStatusFailed] = useState(false);
  // The page watched this robot come online (it was offline here first). That is what makes
  // it "connected" rather than "already online", and an offline after it "connection lost".
  const [witnessedConnect, setWitnessedConnect] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(null); // 'repair' | 'replace' | null
  const [copied, setCopied] = useState(false);

  // Hydration, not polling: read on load, when the live connection comes back (a backend
  // restart forgets codes), and once when a code runs out. Live changes arrive as events.
  const loadStatus = useCallback(
    () =>
      robotsApi.getPairingStatus(robotId).then(
        (next) => {
          setStatus(next);
          setStatusAtMs(Date.now());
          setStatusFailed(false);
        },
        () => setStatusFailed(true),
      ),
    [robotId],
  );

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const connectionState = connection?.state;
  const previousConnectionRef = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionRef.current;
    previousConnectionRef.current = connectionState;
    if (connectionState === CONNECTION.CONNECTED && previous && previous !== CONNECTION.CONNECTED) {
      loadStatus();
    }
  }, [connectionState, loadStatus]);

  // `robot_online` / `robot_offline` move `robot.isOnline` (AppProvider). The page notes the
  // moment it *watched* the robot come online, which is what makes it "connected" here rather
  // than "already online".
  // Adjusted during render rather than in an effect (React's "storing information from
  // previous renders"), so the connected view never flashes the code for one frame.
  const onlineNow = robot ? robot.isOnline === true : null;
  const [lastOnline, setLastOnline] = useState(onlineNow);
  if (onlineNow !== lastOnline) {
    setLastOnline(onlineNow);
    if (lastOnline === false && onlineNow === true) {
      setWitnessedConnect(true);
      setConfirming(null);
      // Spent the moment the robot authenticated with it: no reason to keep it in memory.
      setIssued((prev) => (prev ? { ...prev, code: null } : prev));
    }
  }

  const rejection = pairingRejections?.[robotId] || null;
  const view = useMemo(
    () =>
      deriveEnrollmentView({
        robot,
        robotsLoaded,
        status,
        statusAtMs,
        statusFailed,
        issued,
        rejection,
        witnessedConnect,
        nowMs,
      }),
    [robot, robotsLoaded, status, statusAtMs, statusFailed, issued, rejection, witnessedConnect, nowMs],
  );

  // The countdown: a display clock, running only while a code is on screen. When the code
  // runs out it is dropped from memory, and the status is read once to learn whether the
  // robot locked itself out meanwhile.
  const counting = view.phase === ENROLLMENT_PHASE.WAITING;
  const expiresAtMs = issued?.expiresAtMs ?? null;
  useEffect(() => {
    if (!counting) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (expiresAtMs !== null && now >= expiresAtMs) {
        setIssued((prev) => (prev && prev.code ? { ...prev, code: null } : prev));
        loadStatus();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [counting, expiresAtMs, loadStatus]);

  const issueCode = useCallback(() => {
    setConfirming(null);
    requestAuth(`ISSUE PAIRING CODE: ${robotId}`, async () => {
      const response = await robotsApi.requestPairingCode(robotId);
      const now = Date.now();
      setIssued(issuedCodeFrom(response, now));
      setWitnessedConnect(false);
      setCopied(false);
      setNowMs(now);
      addEvent(`Pairing code issued for ${robotId}`, 'info');
    });
  }, [addEvent, requestAuth, robotId]);

  const command = issued?.code ? enrollmentCommand(issued.code) : '';
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const goToRobot = () => navigate(`/robots/${encodeURIComponent(robotId)}`);
  const chassis = robot?.specification?.chassisType ? CHASSIS_LABEL[robot.specification.chassisType] : null;
  const attemptsLine = (n) =>
    `${n} of ${PAIRING_LOCKOUT_ATTEMPTS} refused attempts used. Pairing locks for up to ${PAIRING_LOCKOUT_MINUTES} minutes after ${PAIRING_LOCKOUT_ATTEMPTS}.`;

  const generateButton = (label = 'Generate Pairing Code') => (
    <Button type="button" onClick={issueCode}>
      <KeyRound className="w-4 h-4" /> {label}
    </Button>
  );

  const continueButton = (
    <Button type="button" onClick={goToRobot}>
      Continue to Robot
    </Button>
  );

  function renderPhase() {
    switch (view.phase) {
      case ENROLLMENT_PHASE.LOADING:
        return (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading robot…
          </div>
        );

      case ENROLLMENT_PHASE.NOT_FOUND:
        return (
          <Notice tone="warning" icon={ShieldAlert} title={`No robot ${robotId}`}>
            It may have been decommissioned.{' '}
            <button type="button" className="underline" onClick={() => navigate('/robots')}>
              Go to the robot list
            </button>
          </Notice>
        );

      case ENROLLMENT_PHASE.SIMULATED:
        return (
          <>
            <Notice title="This is a simulated robot">
              Simulated robots run inside the server and are never paired. There is nothing to connect.
            </Notice>
            {continueButton}
          </>
        );

      case ENROLLMENT_PHASE.STATUS_UNAVAILABLE:
        return (
          <>
            <Notice tone="warning" icon={WifiOff} title="Could not read this robot’s pairing status">
              The server could not be reached. Nothing has been issued.
            </Notice>
            <Button type="button" variant="outline" onClick={loadStatus}>
              <RefreshCw className="w-4 h-4" /> Try again
            </Button>
          </>
        );

      case ENROLLMENT_PHASE.ALREADY_ONLINE:
        return (
          <>
            <Notice tone="success" icon={CheckCircle2} title="This robot is already connected">
              No pairing code is needed. Last seen {formatTime(robot?.lastSeenAt)}.
            </Notice>
            {continueButton}
          </>
        );

      case ENROLLMENT_PHASE.READY:
        return (
          <>
            <ol className="list-decimal pl-5 space-y-1.5 text-sm text-muted-foreground">
              <li>Power on the robot’s Pi and make sure it is connected to the network.</li>
              <li>Generate a one-time pairing code here.</li>
              <li>Run the single command this page gives you on the Pi.</li>
              <li>Keep this page open. It shows the robot as connected the moment it signs in.</li>
            </ol>
            {generateButton()}
          </>
        );

      case ENROLLMENT_PHASE.ENROLLED_OFFLINE:
        return (
          <>
            <Notice icon={Clock} title="This robot is enrolled and currently offline">
              When its Pi is powered on and online it reconnects by itself, with no code. Last seen{' '}
              {formatTime(robot?.lastSeenAt)}. Re-pair only if the robot has lost its stored credential (for
              example, a re-imaged SD card).
            </Notice>
            {confirming === 'repair' ? (
              <ConfirmPanel
                title="Re-pair this robot?"
                confirmLabel="Yes, issue a new code"
                onConfirm={issueCode}
                onCancel={() => setConfirming(null)}
              >
                This issues a new one-time pairing code. When the robot uses it, the robot’s previous
                credential stops working.
              </ConfirmPanel>
            ) : (
              <Button type="button" variant="outline" onClick={() => setConfirming('repair')}>
                <KeyRound className="w-4 h-4" /> Re-pair Robot
              </Button>
            )}
          </>
        );

      case ENROLLMENT_PHASE.CODE_HIDDEN_PENDING:
        return (
          <>
            <Notice icon={KeyRound} title="Pairing code already issued">
              For security it cannot be shown again. If the robot was already given that code, keep this
              page open: it updates when the robot connects.
            </Notice>
            {confirming === 'replace' ? (
              <ConfirmPanel
                title="Issue a new code?"
                confirmLabel="Yes, replace the code"
                onConfirm={issueCode}
                onCancel={() => setConfirming(null)}
              >
                Issuing a new code replaces the previous one. A robot set up with the previous code will be
                refused.
              </ConfirmPanel>
            ) : (
              <Button type="button" variant="outline" onClick={() => setConfirming('replace')}>
                <KeyRound className="w-4 h-4" /> Issue New Code
              </Button>
            )}
          </>
        );

      case ENROLLMENT_PHASE.WAITING:
        return (
          <>
            <div className="rounded-xl border border-border/60 bg-muted/30 p-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Pairing code</div>
                  <div className="mt-1 font-mono text-4xl font-bold tracking-[0.3em]" aria-label="Pairing code">
                    {issued.code}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Expires in</div>
                  <div className="mt-1 font-mono text-2xl font-semibold" aria-live="off">
                    {formatCountdown(view.secondsLeft)}
                  </div>
                </div>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">Single use. It is shown only on this page, only once.</div>
            </div>

            <div>
              <div className="text-sm font-medium">On the robot’s Pi, run:</div>
              <div className="mt-2 flex items-stretch gap-2">
                <pre className="flex-1 overflow-x-auto rounded-lg border border-border/60 bg-slate-950 px-3 py-2 text-xs text-slate-100 select-all">
                  {command}
                </pre>
                <Button type="button" variant="outline" onClick={copyCommand} aria-label="Copy command">
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground">
                It gives the code to the robot’s agent and restarts it. This is needed once: afterwards the robot
                signs in by itself every time it is powered on.
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm font-medium">
              <Loader2 className="w-4 h-4 animate-spin" /> Waiting for robot…
            </div>

            {view.showWaitingHint ? (
              <Notice tone="warning" icon={WifiOff} title="No sign of the robot yet">
                <OfflineChecklist robotId={robotId} />
              </Notice>
            ) : null}

            {confirming === 'replace' ? (
              <ConfirmPanel
                title="Issue a new code?"
                confirmLabel="Yes, replace the code"
                onConfirm={issueCode}
                onCancel={() => setConfirming(null)}
              >
                The code above stops working. A robot set up with it will be refused.
              </ConfirmPanel>
            ) : (
              <button type="button" className="text-xs text-muted-foreground underline self-start" onClick={() => setConfirming('replace')}>
                Issue a new code instead
              </button>
            )}
          </>
        );

      case ENROLLMENT_PHASE.EXPIRED:
        return (
          <>
            <Notice tone="warning" icon={Clock} title="The pairing code expired">
              The robot did not sign in before the code ran out, and it will not retry an expired code.
              Generate a new code and run the new command on the Pi.
              <OfflineChecklist robotId={robotId} />
            </Notice>
            {generateButton('Generate New Code')}
          </>
        );

      case ENROLLMENT_PHASE.REJECTED:
        return (
          <>
            <Notice tone="danger" icon={ShieldAlert} title="The robot was refused">
              It reached the server, but what it presented was not accepted: a wrong or expired pairing code, or a
              stored credential that is no longer valid. The robot does not retry a refused code. Generate a new
              code and run the new command on the Pi.
              <div className="mt-1.5 text-xs">{attemptsLine(view.failedAttempts)}</div>
            </Notice>
            {generateButton('Generate New Code')}
          </>
        );

      case ENROLLMENT_PHASE.LOCKED:
        return (
          <>
            <Notice tone="danger" icon={Lock} title="Pairing is locked for this robot">
              Too many refused attempts ({view.failedAttempts || PAIRING_LOCKOUT_ATTEMPTS}). It unlocks by itself
              within {PAIRING_LOCKOUT_MINUTES} minutes. An administrator can lift it sooner with the pairing-unlock
              override, which needs a recorded reason and a second approver. No code can be used until then.
            </Notice>
            <Button type="button" variant="outline" onClick={loadStatus}>
              <RefreshCw className="w-4 h-4" /> Check again
            </Button>
          </>
        );

      case ENROLLMENT_PHASE.CODE_NO_LONGER_VALID:
        return (
          <>
            <Notice tone="warning" icon={ShieldAlert} title="This code is no longer valid">
              The server no longer holds it: it was replaced from another page, or the server restarted. Generate
              a new code and run the new command on the Pi.
            </Notice>
            {generateButton('Generate New Code')}
          </>
        );

      case ENROLLMENT_PHASE.CONNECTED:
        return (
          <>
            <Notice tone="success" icon={CheckCircle2} title="✓ Robot Connected">
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-emerald-800/80">Robot</dt>
                <dd className="font-mono font-semibold">{robotId}</dd>
                <dt className="text-emerald-800/80">Online</dt>
                <dd className="font-semibold">Yes</dd>
                <dt className="text-emerald-800/80">Last seen</dt>
                <dd>{formatTime(robot?.lastSeenAt)}</dd>
                <dt className="text-emerald-800/80">Connection</dt>
                <dd>Signed in successfully. It will sign in by itself on every future boot.</dd>
              </dl>
            </Notice>
            <div className="text-xs text-muted-foreground">
              Connected is not the same as ready for tasks. Motion and task eligibility are configured separately;
              nothing on this page enables them.
            </div>
            {continueButton}
          </>
        );

      case ENROLLMENT_PHASE.CONNECTION_LOST:
        return (
          <>
            <Notice tone="warning" icon={WifiOff} title="The robot connected, then disconnected">
              If it is restarting or its network dropped briefly, it reconnects by itself and this page shows it.
              If it stays offline, check its power and network. Last seen {formatTime(robot?.lastSeenAt)}.
            </Notice>
            <div className="flex flex-wrap gap-2">
              {continueButton}
              {confirming === 'repair' ? (
                <ConfirmPanel
                  title="Re-pair this robot?"
                  confirmLabel="Yes, issue a new code"
                  onConfirm={issueCode}
                  onCancel={() => setConfirming(null)}
                >
                  Only needed if the robot does not reconnect by itself. When the robot uses the new code, its
                  previous credential stops working.
                </ConfirmPanel>
              ) : (
                <Button type="button" variant="outline" onClick={() => setConfirming('repair')}>
                  <KeyRound className="w-4 h-4" /> Re-pair Robot
                </Button>
              )}
            </div>
          </>
        );

      default:
        return null;
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <button
        type="button"
        onClick={goToRobot}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" /> Back to robot
      </button>

      <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm">
        <CardHeader className="p-6">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-muted-foreground" />
            <CardTitle className="text-lg font-medium">Connect Physical Robot</CardTitle>
          </div>
          <CardDescription>
            Pair the robot’s Raspberry Pi with this server, once. After that it signs in by itself whenever it is
            powered on.
          </CardDescription>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono font-semibold">{robotId}</span>
            {robot?.name ? <span className="text-muted-foreground">· {robot.name}</span> : null}
            {chassis ? <span className="text-muted-foreground">· {chassis}</span> : null}
            {robot ? <RobotIdentityBadge robot={robot} /> : null}
          </div>
        </CardHeader>
        <CardContent className="p-6 pt-0 flex flex-col gap-4">{renderPhase()}</CardContent>
      </Card>
    </div>
  );
}
