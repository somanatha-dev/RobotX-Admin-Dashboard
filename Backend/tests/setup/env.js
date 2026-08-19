// Deterministic test environment. Runs before every test file (jest `setupFiles`).
//
// Deliberately UNSET Redis/Mapbox env vars so `kv.js` boots into its real
// in-memory fallback mode (no live Redis needed) and any accidental call into
// `mapbox.service.js` fails fast instead of hitting the network.
delete process.env.REDIS_URL;
process.env.REDIS_ENABLED = "false";
delete process.env.MAPBOX_TOKEN;
delete process.env.MAPBOX_ACCESS_TOKEN;

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";
process.env.FRONTEND_URL = "https://app.robotx.test";

// Next-generation assignment engine master switch (Phase 0).
//
// The engine under `src/engine/**` is built alongside the legacy dispatcher and is
// inert until the Phase 15 cutover: while this is false no round runs, no
// commitment is written, and no command is emitted. Tests that exercise the engine
// opt in explicitly rather than inheriting a default-on switch, so a phase can
// never accidentally take the legacy suite down a new code path.
process.env.ENGINE_ENABLED = "false";

// Agent mutual-TLS posture (Phase 14, §23.2).
//
// Set explicitly rather than left unset, because "unset" and "false" read identically in
// code and very differently in an incident review. False is the staged posture the Phase
// 15 cutover ends: a presented client certificate is still validated and bound, and
// pairing remains available as the commissioning bootstrap. With it true, an agent
// session without a valid, unrevoked certificate is refused — which is the end state, and
// which the simulated fleet does not yet satisfy.
process.env.AGENT_MTLS_REQUIRED = "false";

// The identity store's two secrets (Phase 14, §23.7).
//
// Set here rather than left unset because the Phase 14 remediation made the production
// intake path a writer of `Stop.identityKey`: `task.service.sealIdentities()` **throws**
// on a missing secret rather than skipping, since a skip would produce exactly the state
// §23.7 exists to prevent — an address with no identity record and no erasure route.
// Fixed, non-random values, so a surrogate key computed in one test file is the same key
// in the next: the stability of the key is the property §23.7 rests on, and a per-run
// secret would make it untestable.
process.env.PRIVACY_SURROGATE_SECRET = "test-surrogate-secret-do-not-use-in-prod";
process.env.PRIVACY_IDENTITY_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
