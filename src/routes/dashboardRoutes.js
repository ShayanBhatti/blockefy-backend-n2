const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const dashboardController = require("../controllers/dashboardController");

// All routes require authentication
router.use(authMiddleware.verifyToken);

// ============================================
// SELLER ROUTES
// ============================================

// Get seller statistics
router.get("/seller/stats", dashboardController.getSellerStats);

// Get seller's active orders
router.get("/seller/orders", dashboardController.getSellerOrders);

// Get seller's gigs with performance
router.get("/seller/gigs", dashboardController.getSellerGigs);

// Get seller's earnings chart data
router.get("/seller/earnings", dashboardController.getSellerEarnings);

// Get seller's reviews
router.get("/seller/reviews", dashboardController.getSellerReviews);

// ============================================
// BUYER ROUTES
// ============================================

// Get buyer statistics
router.get("/buyer/stats", dashboardController.getBuyerStats);

// Get buyer's projects
router.get("/buyer/projects", dashboardController.getBuyerProjects);

// Get buyer's orders
router.get("/buyer/orders", dashboardController.getBuyerOrders);

// Get proposals for buyer's projects
router.get("/buyer/proposals", dashboardController.getBuyerProposals);

// Get recommended talent
router.get("/buyer/talent", dashboardController.getRecommendedTalent);

// ============================================
// SHARED ROUTES
// ============================================

// Get recent activity
router.get("/recent-activity", dashboardController.getRecentActivity);

// Get notifications
router.get("/notifications", dashboardController.getNotifications);

// Mark notification as read
router.patch("/notifications/:id/read", dashboardController.markNotificationRead);

// Mark all notifications as read
router.patch("/notifications/read-all", dashboardController.markAllNotificationsRead);

// Get wallet info
router.get("/wallet", dashboardController.getWalletInfo);

module.exports = router;