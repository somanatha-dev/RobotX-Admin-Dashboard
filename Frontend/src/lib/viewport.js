/**
 * Whether the page is laid out for a wide screen, for the few decisions CSS cannot make on
 * its own — chiefly whether the navigation sidebar starts open.
 *
 * At `lg` (Tailwind's 1024px) and up the sidebar sits beside the content and pushes it over,
 * so it starts open. Below that it is a drawer laid OVER the content, so it starts closed and
 * closes again whenever the operator picks a page — otherwise every page on a phone opens
 * behind a drawer the operator has to dismiss first.
 */

export const WIDE_LAYOUT_QUERY = '(min-width: 1024px)';

function mediaQuery() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(WIDE_LAYOUT_QUERY)
      : null;
  } catch {
    return null;
  }
}

/**
 * True when the sidebar sits beside the content. Where `matchMedia` does not exist (a test
 * runner, a very old browser) the answer is the desktop one, which is what the page did
 * before this helper existed.
 */
export function isWideLayout() {
  const mq = mediaQuery();
  return mq ? Boolean(mq.matches) : true;
}

/**
 * Call `listener(wide)` when the page crosses the `lg` breakpoint — only on a crossing, not on
 * every resize. Returns the unsubscribe; a no-op where `matchMedia` does not exist.
 */
export function subscribeWideLayout(listener) {
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
