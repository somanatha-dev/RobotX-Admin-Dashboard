import test from 'node:test';
import assert from 'node:assert/strict';

import { accountLabel, campusOf, hasInvalidScope, isSuperAdmin, mayCommand } from './access.js';

const CAMPUS = { id: 'c1', code: 'RNSIT', name: 'RNS Institute of Technology', regionId: 'rnsit' };
const SUPER = { isAuthenticated: true, user: { id: 'u1', role: 'SUPER_ADMIN', campus: null } };
const ADMIN = { isAuthenticated: true, user: { id: 'u2', role: 'ADMIN', campus: CAMPUS } };
const BROKEN = { isAuthenticated: true, user: { id: 'u3', role: 'ADMIN', campus: null } };

test('a SUPER_ADMIN is offered every command and has no campus', () => {
  assert.equal(isSuperAdmin(SUPER), true);
  for (const type of ['STOP', 'PAUSE', 'RESUME', 'RETURN']) assert.equal(mayCommand(SUPER, type), true);
  assert.equal(campusOf(SUPER), null);
  assert.equal(hasInvalidScope(SUPER), false);
});

test('a campus ADMIN is offered STOP and PAUSE only — the server enforces the same', () => {
  assert.equal(isSuperAdmin(ADMIN), false);
  assert.equal(mayCommand(ADMIN, 'STOP'), true);
  assert.equal(mayCommand(ADMIN, 'pause'), true);
  assert.equal(mayCommand(ADMIN, 'RESUME'), false);
  assert.equal(mayCommand(ADMIN, 'RETURN'), false);
  assert.equal(accountLabel(ADMIN), 'Admin · RNS Institute of Technology');
});

test('an ADMIN with no campus is offered nothing and is told why', () => {
  assert.equal(hasInvalidScope(BROKEN), true);
  assert.equal(mayCommand(BROKEN, 'STOP'), false);
  assert.equal(accountLabel(BROKEN), 'Admin · no campus assigned');
});

test('a role the server did not send grants nothing', () => {
  const unknown = { isAuthenticated: true, user: { role: 'OWNER' } };
  assert.equal(isSuperAdmin(unknown), false);
  assert.equal(mayCommand(unknown, 'STOP'), false);
  assert.equal(hasInvalidScope(unknown), true);
});
