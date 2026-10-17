import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { RequiredMark } from '@/components/system/RequiredMark.jsx';
import { useAppActions } from '@/context/appContext.js';
import * as robotsApi from '@/lib/api/robots.js';
import {
  RECOMMISSION_CONSEQUENCES,
  RECOMMISSION_REASON_MAX,
  sortRetiredForChoice,
  validateRecommissionDraft,
} from '@/lib/robotRecommission.js';

const formatTime = (iso) => {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
};

/**
 * "Recommission retired robot" — the explicit path for bringing a retired unit's own record
 * back, as opposed to commissioning a new unit.
 *
 * The list comes from the server and so does every decision: the role check, the reason and
 * confirmation checks, the outcome. Submitting goes through the provider's `recommission`,
 * which asks for the step-up first and reports only what the server answered.
 *
 * @param {{ initialRobotId?: string }} props a unit to preselect (from a refused commissioning)
 */
export function RecommissionRetiredUnit({ initialRobotId }) {
  const { recommission } = useAppActions();

  const [load, setLoad] = useState({ status: 'loading', rows: [], error: '' });
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState(String(initialRobotId || '').trim());
  const [confirmId, setConfirmId] = useState('');
  const [reason, setReason] = useState('');
  const [showProblems, setShowProblems] = useState(false);

  useEffect(() => {
    let live = true;
    robotsApi.listRetiredRobots().then(
      (rows) => {
        if (live) setLoad({ status: 'ready', rows: sortRetiredForChoice(rows), error: '' });
      },
      (err) => {
        if (live) setLoad({ status: 'error', rows: [], error: err?.message || 'Could not load the retired robots.' });
      },
    );
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const reload = () => {
    setLoad((prev) => ({ ...prev, status: 'loading', error: '' }));
    setReloadKey((n) => n + 1);
  };

  const selected = load.rows.find((row) => row.robotId === selectedId) || null;
  const validation = validateRecommissionDraft({ robotId: selected ? selected.robotId : '', confirmRobotId: confirmId, reason });
  const canSubmit = Boolean(selected && selected.recommissionable) && validation.ok;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit) {
      setShowProblems(true);
      return;
    }
    recommission({ robotId: selected.robotId, confirmRobotId: confirmId, reason });
  };

  return (
    <form id="recommission-retired-unit" onSubmit={handleSubmit} className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm">
          <CardHeader className="p-6">
            <CardTitle className="text-lg font-medium">Retired robot</CardTitle>
            <CardDescription>
              Choose the retired unit to bring back. This is the same robot, not a new one: it keeps its identifier and history.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-0 space-y-4">
            {load.status === 'error' ? (
              <div className="rounded-lg bg-destructive/10 text-destructive px-4 py-3 text-sm font-medium" role="alert">
                {load.error}
                <div className="mt-2">
                  <Button type="button" size="sm" variant="outline" onClick={reload}>
                    <RefreshCw className="w-4 h-4" /> Retry
                  </Button>
                </div>
              </div>
            ) : null}

            {load.status === 'loading' ? <p className="text-sm text-muted-foreground">Loading retired robots…</p> : null}

            {load.status === 'ready' && load.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">There are no retired robots.</p>
            ) : null}

            {load.status === 'ready' && load.rows.length > 0 ? (
              <div>
                <Label className="mb-2 block">
                  Unit <RequiredMark />
                </Label>
                <div className="flex items-center gap-2">
                  <Select
                    value={selected ? selected.robotId : ''}
                    onValueChange={(value) => {
                      setSelectedId(value);
                      setConfirmId('');
                      setShowProblems(false);
                    }}
                  >
                    <SelectTrigger aria-label="Retired unit">
                      <SelectValue placeholder="Select a retired unit" />
                    </SelectTrigger>
                    <SelectContent>
                      {load.rows.map((row) => (
                        <SelectItem key={row.robotId} value={row.robotId} disabled={!row.recommissionable}>
                          {row.robotId}
                          {row.name ? ` — ${row.name}` : ''}
                          {row.recommissionable ? '' : ' (simulated, cannot be recommissioned)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="sm" variant="ghost" onClick={reload} aria-label="Refresh the retired list">
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
                {selectedId && !selected ? (
                  <p className="mt-2 text-xs text-destructive">
                    {selectedId} is not in the retired list. It may already have been recommissioned, or it was never retired.
                  </p>
                ) : null}
              </div>
            ) : null}

            {selected ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Identifier</dt>
                <dd className="font-mono font-semibold">{selected.robotId}</dd>
                <dt className="text-muted-foreground">Name</dt>
                <dd>{selected.name || '—'}</dd>
                <dt className="text-muted-foreground">Last location</dt>
                <dd>{selected.locationName || '—'}</dd>
                <dt className="text-muted-foreground">Last seen</dt>
                <dd>{formatTime(selected.lastSeenAt)}</dd>
                <dt className="text-muted-foreground">Retired</dt>
                <dd>{formatTime(selected.retiredAt)}</dd>
                <dt className="text-muted-foreground">Kind</dt>
                <dd>
                  <Badge variant="secondary">{selected.simulated ? 'Simulated' : 'Physical'}</Badge>
                </dd>
              </dl>
            ) : null}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm">
          <CardHeader className="p-6">
            <CardTitle className="text-lg font-medium">Authorise recommissioning</CardTitle>
            <CardDescription>Requires an administrator account. The reason is recorded with your account in the unit’s audit trail.</CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-0 space-y-6">
            <div>
              <Label htmlFor="recommission-reason" className="mb-2 block">
                Reason <RequiredMark />
              </Label>
              <textarea
                id="recommission-reason"
                value={reason}
                maxLength={RECOMMISSION_REASON_MAX}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Repaired and re-inspected; returning to service"
                className="flex w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-ring"
              />
              <div className="mt-1 text-xs text-muted-foreground text-right">
                {reason.trim().length}/{RECOMMISSION_REASON_MAX}
              </div>
            </div>

            <div>
              <Label htmlFor="recommission-confirm" className="mb-2 block">
                Type {selected ? <span className="font-mono font-semibold">{selected.robotId}</span> : 'the unit identifier'} to confirm{' '}
                <RequiredMark />
              </Label>
              <Input
                id="recommission-confirm"
                value={confirmId}
                onChange={(e) => setConfirmId(e.target.value)}
                disabled={!selected || !selected.recommissionable}
                autoComplete="off"
                className="font-mono font-semibold"
              />
            </div>

            {showProblems && !validation.ok ? (
              <div className="rounded-lg bg-destructive/10 text-destructive px-4 py-3 text-sm font-medium" role="alert">
                {validation.problems.join(' ')}
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button type="submit" disabled={!selected || !selected.recommissionable}>
                <RotateCcw className="w-4 h-4" /> {selected ? `Recommission ${selected.robotId}` : 'Recommission'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <aside className="lg:col-span-1">
        <Card className="rounded-2xl border border-border/60 shadow-sm hover:shadow-sm bg-muted/40">
          <CardHeader className="p-6">
            <CardTitle className="text-lg font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> What recommissioning does
            </CardTitle>
            <CardDescription>Read this before you confirm.</CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-0">
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-2" data-recommission-consequences>
              {RECOMMISSION_CONSEQUENCES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-muted-foreground">
              A new robot never reuses a retired identifier. Use <span className="font-medium text-foreground">Commission new unit</span> with a different identifier for that.
            </p>
          </CardContent>
        </Card>
      </aside>
    </form>
  );
}

export default RecommissionRetiredUnit;
