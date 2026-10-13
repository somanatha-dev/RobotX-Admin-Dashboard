/**
 * The operator's `prefers-reduced-motion` setting, for imperative animation code
 * (rAF loops, interval-driven paint animation) that CSS media queries cannot reach.
 *
 * Under reduced motion the map still shows every state change — a robot is placed at
 * each new sample instead of tweened there, a route's direction is a static dash, a
 * charging station's activity is a steady ring — it just does not animate between them.
 */

const QUERY = '(prefers-reduced-motion: reduce)';

function mediaQuery() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
  } catch {
    return null;
  }
}

/** True when the operator asked the system for reduced motion. */
export function prefersReducedMotion() {
  return Boolean(mediaQuery()?.matches);
}

/**
 * Call `listener(reduced)` whenever the setting changes. Returns the unsubscribe.
 * A no-op (with a no-op unsubscribe) where `matchMedia` does not exist.
 */
export function subscribeReducedMotion(listener) {
  const mq = mediaQuery();
  if (!mq || typeof listener !== 'function') return () => {};
  const onChange = (event) => listener(Boolean(event?.matches));
  try {
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  } catch {
    return () => {};
  }
}

/** False while the page is in a background tab — animation there is invisible work. */
export function documentVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}
