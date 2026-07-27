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
