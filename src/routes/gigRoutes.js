const express = require("express");
const gigController = require("../controllers/gigController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Create gig (protected route)
router.post("/create", authMiddleware.verifyToken, gigController.createGig);

module.exports = router;
