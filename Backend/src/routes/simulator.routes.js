const express = require("express");
const ctrl    = require("../controllers/simulator.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireElevatedRole } = require("../middlewares/auth_middleware");

const router = express.Router();

// Every route here requires an authenticated operator. For the creation route below that
// is not just access control: `req.user.id` **is** the creator fact recorded on the row,
// so an unauthenticated request has nothing to attribute the robot it would create to.
router.use(authUser);

// The same bucket size the physical commissioning route uses. A creation attempt is a
// creation attempt, and the limiter is about request rate, not about how many simulated
// robots may exist — nothing limits that.
const createLimiter = createRateLimiter({ windowMs: 60_000, limit: 30, keyPrefix: "simulator_robot" });

// ── SUPER_ADMIN only, enforced HERE and not in the browser ───────────────────
//
// `requireElevatedRole()` is PHASE 14's existing §23.4 role gate. It resolves
// `security.elevated_roles` from the parameter register — whose default is exactly
// `["SUPER_ADMIN"]` — and answers 403 for anything else. This is the same middleware
// `config.routes.js` and `privacy.routes.js` mount for their whole router and that
// `shards.routes.js` puts on `POST /:id/rebalance`, so a *write* behind it is the
// established pattern rather than a new reading of it.
//
// ── Why this gate and not one of the action classes ──────────────────────────
// §23.4's four high-privilege action classes — quarantine override, safety-class config
// change, bulk cancellation, manual assignment against a Policy constraint — are a closed
// register of acts on the *live fleet*, each carrying a mandatory recorded reason and,
// for two of them, a second approver. Creating a test agent is none of those, and
// inventing a fifth class for it would be redesigning the security architecture, not
// reusing it. `requireElevatedRole()` exists precisely for a surface that is privileged
// without being one of the four, which is what this is.
//
// ── What was NOT changed ─────────────────────────────────────────────────────
// No new passkey, WebAuthn, fingerprint, PIN or step-up mechanism is introduced here, and
// none of the existing ones is touched, duplicated or weakened. The WebAuthn/PIN
// ceremonies remain exactly where they are (`/api/auth/webauthn/*`, `/api/auth/pin-auth`),
// commissioning and task creation keep the protection they already had, and this route
// acquires no exemption from anything. It gains a server-side role check it did not have.
const superAdminOnly = requireElevatedRole();

// POST /api/simulator/robot — create exactly ONE simulated robot per request.
//
// There is deliberately no `POST /api/simulator/fleet`, no count-based form and no bulk
// route. One request creates one robot. A SUPER_ADMIN who wants SIM-001, SIM-002 and
// SIM-003 sends this three times; there is no per-operator limit on how many they may
// have, and the server generates a distinct identifier every time.
router.post("/robot", createLimiter, superAdminOnly, ctrl.createSimulatedRobot);

// GET  /api/simulator/status  — snapshot of all virtual robots
router.get("/status", ctrl.getStatus);

// POST /api/simulator/start   — (re)start all virtual robots
router.post("/start", ctrl.startSimulator);

// POST /api/simulator/stop    — disconnect & pause all virtual robots
//
// ── KNOWN LIMITATION, stated rather than glossed ────────────────────────────
// `stop`, `reset` and `start` are **fleet-wide**: they act on every VirtualRobot this
// process manages, including simulated robots created by other operators. They are also
// still gated by `authUser` alone, not by `superAdminOnly` — the correction that added
// the role gate was scoped to the creation endpoint it names, and widening it to the
// control routes is a separate decision about who may stop somebody else's simulator.
//
// Nothing here claims otherwise, and the creation endpoint does not imply otherwise
// either. Owner-scoped simulator control is a separate piece of work — it needs a
// per-owner view of the engine's robot list and a decision about what an elevated role may
// do across owners — and turning these three routes into a multi-user control plane was
// explicitly out of scope for this step. See `docs/` and the Step 2 report.
//
// ── STEP 3 left this exactly as it found it ─────────────────────────────────
// Step 3 added the operator-facing UI for *creating* a simulated robot and for *reading*
// this router's `GET /status`. It deliberately added no control surface: there is no
// start, stop or reset button anywhere in the frontend, because a per-operator button
// wired to a fleet-wide route would be a UI that quietly claims a scope the backend does
// not have. The limitation is unchanged and still open.
router.post("/stop", ctrl.stopSimulator);

// POST /api/simulator/reset   — clear task state on all virtual robots (fleet-wide; see above)
router.post("/reset", ctrl.resetSimulator);

// PATCH /api/simulator/config — update runtime config (reserved)
router.patch("/config", ctrl.setConfig);

module.exports = router;
