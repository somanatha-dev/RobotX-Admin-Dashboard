const express = require("express");
const campusesController = require("../controllers/campuses.controller");

const router = express.Router();

router.get("/", campusesController.listCampuses);
router.post("/", campusesController.createCampus);

module.exports = router;
