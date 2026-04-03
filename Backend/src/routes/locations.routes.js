const express = require("express");
const locationsController = require("../controllers/locations.controller");

const router = express.Router();

router.get("/", locationsController.listLocations);
router.post("/", locationsController.createLocation);
router.get("/:id/descendants", locationsController.listDescendants);

module.exports = router;
