const express = require("express");
const gigController = require("../controllers/gigController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// ============================================
// GIG CREATION & MANAGEMENT
// ============================================

// Create gig (protected route) - can save as draft or post directly
router.post("/create", authMiddleware.verifyToken, gigController.createGig);

// Save/Update draft gig (protected route)
router.post("/draft", authMiddleware.verifyToken, gigController.saveDraftGig);

// Update gig (both draft and posted) (protected route)
router.put("/:gigId", authMiddleware.verifyToken, gigController.updateGig);

// Delete gig (protected route)
router.delete("/:gigId", authMiddleware.verifyToken, gigController.deleteGig);

// ============================================
// PUBLISH/UNPUBLISH
// ============================================

// Publish draft gig (convert draft to posted) (protected route)
router.put("/:gigId/publish", authMiddleware.verifyToken, gigController.publishGig);

// Unpublish posted gig (convert posted to draft) (protected route)
router.put("/:gigId/unpublish", authMiddleware.verifyToken, gigController.unpublishGig);

// ============================================
// GET GIGS
// ============================================

// Get all gigs of the logged-in user (both draft and posted) (protected route)
router.get("/my-gigs", authMiddleware.verifyToken, gigController.getAllUserGigs);

// Get only draft gigs (protected route)
router.get("/my-gigs/drafts", authMiddleware.verifyToken, gigController.getDraftGigs);

// Get only posted gigs (protected route)
router.get("/my-gigs/posted", authMiddleware.verifyToken, gigController.getPostedGigs);

// ============================================
// PUBLIC ROUTES
// ============================================

// Get all sellers/freelancers with card details (public route)
router.get("/sellers", gigController.getAllSellers);

// Get detailed profile of a specific seller with their gigs (public route)
router.get("/sellers/:sellerId", gigController.getSellerDetails);

// Get all gigs from all sellers (public route - for buyers to browse)
router.get("/browse/all", gigController.getAllGigs);

// Get detailed information of a specific gig (public route)
router.get("/:gigId", gigController.getGigDetails);

module.exports = router;
