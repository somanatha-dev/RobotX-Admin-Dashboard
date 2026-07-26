const express = require("express");
const campusesController = require("../controllers/campuses.controller");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);

router.get("/", campusesController.listCampuses);
router.post("/", campusesController.createCampus);

module.exports = router;
