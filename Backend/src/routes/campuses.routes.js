const express = require("express");
const campusesController = require("../controllers/campuses.controller");
const { authUser, requireScopedAccess, requireSuperAdmin } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);
// RBAC — an ADMIN without a valid campus is refused on every route here.
router.use(requireScopedAccess());

// ── RBAC: ADMIN-capable — an ADMIN's list holds only its own campus ────────────
router.get("/", campusesController.listCampuses);

// ── RBAC: SUPER_ADMIN only — every route below this line ───────────────────────
router.use(requireSuperAdmin());

router.post("/", campusesController.createCampus);
// The campus → operating-region link campus-scoped task access is decided by.
router.put("/:id/region", campusesController.linkCampusRegion);

module.exports = router;
