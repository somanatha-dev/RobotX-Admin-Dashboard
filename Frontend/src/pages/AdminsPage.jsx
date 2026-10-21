import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, UserPlus } from 'lucide-react';

import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card } from '@/components/ui/card.jsx';
import { Input } from '@/components/ui/input.jsx';
import * as usersApi from '@/lib/api/users.js';
import { listCampuses } from '@/lib/api/locations.js';

// RBAC — campus administrator accounts. Reached only through the SUPER_ADMIN route guard, and
// every action here is refused by the server to anyone else; the guard only keeps the page
// from being offered. The role is not a field: the server creates ADMIN accounts only, each
// with exactly one campus, and records every change on the audit stream.

const MIN_PASSWORD = 12;

function CampusSelect({ campuses, value, onChange, id, disabled }) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
    >
      <option value="">Select a campus…</option>
      {campuses.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.code}){c.regionId ? '' : ' — no operating region'}
        </option>
      ))}
    </select>
  );
}

export default function AdminsPage() {
  const [users, setUsers] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [draft, setDraft] = useState({ email: '', password: '', campusId: '' });
  const [createError, setCreateError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [rowError, setRowError] = useState({});
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError('');
    try {
      const [nextUsers, nextCampuses] = await Promise.all([usersApi.listUsers(), listCampuses()]);
      setUsers(nextUsers);
      setCampuses(nextCampuses);
    } catch (e) {
      setLoadError(e?.message || 'Could not load accounts.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const draftProblem = !draft.email.trim()
    ? 'Enter an email address.'
    : draft.password.length < MIN_PASSWORD
      ? `The password must be at least ${MIN_PASSWORD} characters.`
      : !draft.campusId
        ? 'Choose the one campus this administrator manages.'
        : '';

  const handleCreate = async (event) => {
    event.preventDefault();
    if (draftProblem) {
      setCreateError(draftProblem);
      return;
    }
    setIsCreating(true);
    setCreateError('');
    try {
      await usersApi.createAdmin({ email: draft.email.trim(), password: draft.password, campusId: draft.campusId });
      setDraft({ email: '', password: '', campusId: '' });
      await load();
    } catch (e) {
      setCreateError(e?.message || 'Could not create the administrator.');
    } finally {
      setIsCreating(false);
    }
  };

  const patch = async (user, change) => {
    setBusyId(user.id);
    setRowError((prev) => ({ ...prev, [user.id]: '' }));
    try {
      const updated = await usersApi.updateAdmin(user.id, change);
      if (updated) setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (e) {
      setRowError((prev) => ({ ...prev, [user.id]: e?.message || 'The change was refused.' }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-slate-50">
      <div className="mx-auto w-full max-w-5xl space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Campus administrators</h1>
            <p className="text-sm text-slate-500">
              Each administrator manages exactly one campus. Only a super administrator can create or change these accounts.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={load} disabled={isLoading} className="self-start sm:self-auto shrink-0">
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>

        <Card className="p-4 sm:p-5">
          <form onSubmit={handleCreate} className="space-y-4" aria-label="Create a campus administrator">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">New administrator</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="font-medium text-slate-700">Email</span>
                <Input type="email" autoComplete="off" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium text-slate-700">Initial password</span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={draft.password}
                  onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm" htmlFor="new-admin-campus">
                <span className="font-medium text-slate-700">Campus</span>
                <CampusSelect id="new-admin-campus" campuses={campuses} value={draft.campusId} onChange={(campusId) => setDraft((d) => ({ ...d, campusId }))} />
              </label>
            </div>
            <p className="text-xs text-slate-500">
              Share the initial password with the administrator privately; they can change it from their profile.
            </p>
            {createError ? (
              <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {createError}
              </div>
            ) : null}
            <Button type="submit" size="sm" disabled={isCreating}>
              <UserPlus className="h-4 w-4" /> {isCreating ? 'Creating…' : 'Create administrator'}
            </Button>
          </form>
        </Card>

        <Card className="overflow-hidden">
          {loadError ? (
            <div role="alert" className="p-5 text-sm text-rose-800">{loadError}</div>
          ) : isLoading && users.length === 0 ? (
            <div role="status" className="p-5 text-sm text-slate-500">Loading accounts…</div>
          ) : (
            // Below `md` each row is a card: the same cells stacked, each with its label, since four
            // columns (one holding a select and a button) do not fit a phone.
            <table className="block md:table w-full text-sm">
              <thead className="hidden md:table-header-group bg-slate-50 text-left text-xs uppercase tracking-widest text-slate-500">
                <tr>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Campus</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group divide-y divide-slate-100">
                {users.map((u) => {
                  const managed = u.role === 'ADMIN';
                  return (
                    <tr key={u.id} className="block md:table-row align-top py-2 md:py-0">
                      <td className="block md:table-cell px-4 py-1.5 md:py-3">
                        <div className="font-medium text-slate-900 wrap-anywhere">{u.email}</div>
                        {rowError[u.id] ? <div role="alert" className="mt-1 text-xs text-rose-700">{rowError[u.id]}</div> : null}
                      </td>
                      <td className="flex md:table-cell items-center justify-between gap-3 px-4 py-1.5 md:py-3">
                        <span className="md:hidden text-xs uppercase tracking-widest text-slate-500">Role</span>
                        <Badge variant={managed ? 'secondary' : 'default'}>{managed ? 'Admin' : 'Super Admin'}</Badge>
                      </td>
                      <td className="flex md:table-cell items-center justify-between gap-3 px-4 py-1.5 md:py-3">
                        <span className="md:hidden shrink-0 text-xs uppercase tracking-widest text-slate-500">Campus</span>
                        {managed ? (
                          <CampusSelect
                            id={`campus-${u.id}`}
                            campuses={campuses}
                            value={u.campus?.id || ''}
                            disabled={busyId === u.id}
                            onChange={(campusId) => campusId && campusId !== u.campus?.id && patch(u, { campusId })}
                          />
                        ) : (
                          <span className="text-slate-500">All campuses</span>
                        )}
                      </td>
                      <td className="flex md:table-cell items-center justify-between gap-3 px-4 py-1.5 md:py-3">
                        <span className="md:hidden text-xs uppercase tracking-widest text-slate-500">Status</span>
                        {managed ? (
                          <div className="flex items-center gap-2">
                            <Badge variant={u.disabled ? 'destructive' : 'outline'}>{u.disabled ? 'Disabled' : 'Active'}</Badge>
                            <Button type="button" size="sm" variant="outline" disabled={busyId === u.id} onClick={() => patch(u, { disabled: !u.disabled })}>
                              {u.disabled ? 'Enable' : 'Disable'}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
