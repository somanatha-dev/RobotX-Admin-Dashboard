"use strict";

/**
 * Safe JSON.parse that never throws.
 * Returns null when the input is empty, null, or invalid JSON.
 *
 * @param {string|null|undefined} raw
 * @returns {any|null}
 */
function safeJsonParse(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = { safeJsonParse };
