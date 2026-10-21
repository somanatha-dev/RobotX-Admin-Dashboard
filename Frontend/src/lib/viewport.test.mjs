import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WIDE_LAYOUT_QUERY, isWideLayout, subscribeWideLayout } from './viewport.js';

function withMatchMedia(impl, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previous = globalThis.window;
  globalThis.window = impl === undefined ? {} : { matchMedia: impl };
  try {
    return fn();
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
}

test('the wide layout is the lg breakpoint the sidebar markup uses', () => {
  assert.equal(WIDE_LAYOUT_QUERY, '(min-width: 1024px)');
});

test('a phone-width viewport is not the wide layout, a desktop one is', () => {
  const seen = [];
  const narrow = withMatchMedia((q) => (seen.push(q), { matches: false }), isWideLayout);
  const wide = withMatchMedia(() => ({ matches: true }), isWideLayout);
  assert.equal(narrow, false);
  assert.equal(wide, true);
  assert.deepEqual(seen, [WIDE_LAYOUT_QUERY]);
});

test('without matchMedia the answer is the desktop one (the behaviour before the helper)', () => {
  assert.equal(withMatchMedia(undefined, isWideLayout), true);
  assert.equal(
    withMatchMedia(() => {
      throw new Error('blocked');
    }, isWideLayout),
    true,
  );
});

test('crossing the breakpoint reports the new width once; unsubscribing stops it', () => {
  const listeners = new Set();
  const mq = {
    matches: true,
    addEventListener: (type, fn) => type === 'change' && listeners.add(fn),
    removeEventListener: (type, fn) => type === 'change' && listeners.delete(fn),
  };
  const seen = [];
  const unsubscribe = withMatchMedia(() => mq, () => subscribeWideLayout((wide) => seen.push(wide)));
  assert.equal(listeners.size, 1, 'one change listener');
  assert.deepEqual(seen, [], 'nothing is reported until a crossing');
  for (const fn of listeners) fn({ matches: false });
  for (const fn of listeners) fn({ matches: true });
  assert.deepEqual(seen, [false, true]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test('without matchMedia the subscription is a harmless no-op', () => {
  const unsubscribe = withMatchMedia(undefined, () => subscribeWideLayout(() => assert.fail('never called')));
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
  assert.equal(typeof withMatchMedia(() => ({ matches: true }), () => subscribeWideLayout(null)), 'function');
});
