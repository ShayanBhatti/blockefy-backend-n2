const express = require("express");
const gigController = require("../controllers/gigController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Create gig (protected route)
router.post("/create", authMiddleware.verifyToken, gigController.createGig);

// Get all gigs of the logged-in user (protected route)
router.get("/my-gigs", authMiddleware.verifyToken, gigController.getAllUserGigs);

// Get all sellers/freelancers with card details (public route)
router.get("/sellers", gigController.getAllSellers);

// Get detailed profile of a specific seller with their gigs (public route)
router.get("/sellers/:sellerId", gigController.getSellerDetails);

// Get all gigs from all sellers (public route - for buyers to browse)
router.get("/browse/all", gigController.getAllGigs);

// Get detailed information of a specific gig (public route)
router.get("/:gigId", gigController.getGigDetails);

module.exports = router;
