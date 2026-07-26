const express = require("express");
const locationsController = require("../controllers/locations.controller");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);

router.get("/", locationsController.listLocations);
router.post("/", locationsController.createLocation);
router.get("/:id/descendants", locationsController.listDescendants);

module.exports = router;
