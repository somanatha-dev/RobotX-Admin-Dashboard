const express = require("express");
const locationsController = require("../controllers/locations.controller");
const { authUser, requireSuperAdmin } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);
// RBAC — SUPER_ADMIN only: no route on this router is open to a campus administrator.
router.use(requireSuperAdmin());

router.get("/", locationsController.listLocations);
router.post("/", locationsController.createLocation);
router.get("/:id/descendants", locationsController.listDescendants);

module.exports = router;
