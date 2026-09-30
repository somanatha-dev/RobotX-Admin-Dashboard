"use strict";

/**
 * **Is this database a throwaway local cluster?** — the one check every V1 demonstration
 * tool that writes makes before it connects.
 *
 * Deliberately dependency-free: `tools/demo/startV1Server.js` must run it *before* anything
 * under `src/` is required, because `src/config/env.js` loads `Backend/.env` — whose
 * `DATABASE_URL` is the shared Neon instance — on first require.
 *
 * The URL is parsed with WHATWG `URL` (not matched as a string), so a hostname such as
 * `127.0.0.1.neon.tech` or a userinfo containing `localhost` cannot pass.
 */

/** Hosts a demonstration world may live on. `[::1]` is how `URL` spells IPv6 loopback. */
const LOCAL_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Refuse any database that is not a disposable local cluster.
 *
 * @param {string} url
 * @param {{ purpose?: string }} [options] what the caller is about to do, for the message
 * @returns {string} the URL, unchanged
 * @throws {Error} naming the host or port that was refused
 */
function assertDisposableLocal(url, options = {}) {
  const purpose = options.purpose || "seed a demonstration world";
  if (!url) throw new Error("no database URL: pass --database-url");
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error("the database URL could not be parsed; refusing to connect");
  }
  if (!/^postgres(ql)?:$/u.test(target.protocol)) {
    throw new Error(`refusing to ${purpose}: protocol "${target.protocol}" is not postgres`);
  }
  if (!LOCAL_HOSTS.includes(target.hostname)) {
    throw new Error(
      `refusing to ${purpose} on host "${target.hostname}". Only ${LOCAL_HOSTS.join(", ")} are permitted — ` +
        "never Neon, never a remote or shared cluster. Use a throwaway local PostgreSQL (see " +
        "docs/runbooks/v1-demonstration-assignment.md §4).",
    );
  }
  // A connection-string parameter can redirect the connection after the hostname above was
  // checked (`?host=` is honoured by libpq-style clients), so none that names a host is admitted.
  for (const name of ["host", "hostaddr", "sslhost"]) {
    if (target.searchParams.has(name)) {
      throw new Error(`refusing to ${purpose}: the URL's "${name}" parameter could redirect it off this machine`);
    }
  }
  if (target.port === "" || target.port === "5432") {
    throw new Error(`port "${target.port || "(default)"}" is the developer's own cluster; use a throwaway one`);
  }
  return url;
}

module.exports = { LOCAL_HOSTS, assertDisposableLocal };
