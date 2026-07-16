const Order = require("../models/Order");
const Gig = require("../models/Gig");
const Project = require("../models/Project");
const Proposal = require("../models/Proposal");
const Milestone = require("../models/Milestone");
const Review = require("../models/Review");
const Transaction = require("../models/Transaction");
const Notification = require("../models/Notification");
const Activity = require("../models/Activity");
const User = require("../models/User");

// Helper function to calculate profile strength
const calculateProfileStrength = async (userId, role) => {
  const user = await User.findById(userId).lean();
  if (!user) return 0;

  let score = 0;
  const maxScore = 100;

  // Common fields (40 points)
  if (user.fullName) score += 10;
  if (user.username) score += 10;
  if (user.profileImage?.url) score += 10;
  if (user.email && user.emailVerified) score += 10;

  // Role-specific fields
  if (role === "seller") {
    // Seller-specific (60 points)
    if (user.sellerProfile?.bio) score += 15;
    if (user.sellerProfile?.skills?.length > 0) score += 15;
    if (user.sellerProfile?.portfolio?.length > 0) score += 15;
    if (user.sellerProfile?.languages?.length > 0) score += 15;
  } else {
    // Buyer-specific (60 points)
    if (user.buyerProfile?.company) score += 15;
    if (user.buyerProfile?.interests?.length > 0) score += 15;
    if (user.buyerProfile?.budgetRange?.min) score += 15;
    if (user.buyerProfile?.preferredCategories?.length > 0) score += 15;
  }

  return Math.min(score, maxScore);
};

// ============================================
// SELLER DASHBOARD APIs
// ============================================

/**
 * GET /dashboard/seller/stats
 * Get seller statistics for dashboard
 */
const getSellerStats = async (req, res) => {
  try {
    const userId = req.user._id;

    // Get active orders count
    const activeOrders = await Order.countDocuments({
      sellerId: userId,
      status: { $in: ["pending", "active", "in_progress", "review"] },
    });

    // Get completed orders count (this month)
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const completedOrdersThisMonth = await Order.countDocuments({
      sellerId: userId,
      status: "completed",
      completedAt: { $gte: startOfMonth },
    });

    // Calculate earnings this month
    const earningsAggregation = await Order.aggregate([
      {
        $match: {
          sellerId: userId,
          status: "completed",
          createdAt: { $gte: startOfMonth },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$sellerEarnings" },
        },
      },
    ]);
    const monthlyEarnings = earningsAggregation[0]?.total || 0;

    // Get total earnings all time
    const totalEarningsAggregation = await Order.aggregate([
      {
        $match: {
          sellerId: userId,
          status: "completed",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$sellerEarnings" },
        },
      },
    ]);
    const totalEarnings = totalEarningsAggregation[0]?.total || 0;

    // Get gigs count
    const gigsCount = await Gig.countDocuments({ userId });

    // Get total gig views (would need to track this in Gig model)
    const gigs = await Gig.find({ userId }).select("title").lean();
    const gigViews = gigs.length * 100; // Placeholder - should be from actual views

    // Get profile strength
    const profileStrength = await calculateProfileStrength(userId, "seller");

    // Get wallet balance
    const walletBalance = await Transaction.getUserBalance(userId);

    // Get response rate (orders responded within 24h / total orders)
    const totalOrders = await Order.countDocuments({ sellerId: userId });
    const responseTimeAggregation = await Order.aggregate([
      {
        $match: {
          sellerId: userId,
          startDate: { $exists: true },
        },
      },
      {
        $project: {
          responseTime: {
            $subtract: ["$startDate", "$createdAt"],
          },
        },
      },
      {
        $group: {
          _id: null,
          avgResponseTime: { $avg: "$responseTime" },
        },
      },
    ]);
    const avgResponseTimeMs = responseTimeAggregation[0]?.avgResponseTime || 0;
    const avgResponseTimeHours = Math.round(avgResponseTimeMs / (1000 * 60 * 60));

    // Get delivery rate (completed on time / total completed)
    const completedOnTime = await Order.countDocuments({
      sellerId: userId,
      status: "completed",
      isLate: false,
    });
    const deliveryRate = totalOrders > 0 ? Math.round((completedOnTime / totalOrders) * 100) : 100;

    // Get review stats
    const reviewStats = await Review.calculateAverageRating(userId);

    res.json({
      success: true,
      data: {
        activeOrders,
        completedOrdersThisMonth,
        monthlyEarnings,
        totalEarnings,
        gigsCount,
        gigViews,
        profileStrength,
        walletBalance,
        responseTime: avgResponseTimeHours,
        deliveryRate,
        averageRating: reviewStats.avgRating,
        totalReviews: reviewStats.totalReviews,
      },
    });
  } catch (error) {
    console.error("Error getting seller stats:", error);
    res.status(500).json({ success: false, message: "Failed to fetch seller stats" });
  }
};

/**
 * GET /dashboard/seller/orders
 * Get seller's active orders
 */
const getSellerOrders = async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, limit = 10, page = 1 } = req.query;

    const query = { sellerId: userId };
    if (status) {
      query.status = status;
    } else {
      query.status = { $in: ["pending", "active", "in_progress", "review"] };
    }

    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      Order.find(query)
        .populate("buyerId", "fullName username profileImage")
        .populate("gigId", "title images")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error getting seller orders:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
};

/**
 * GET /dashboard/seller/gigs
 * Get seller's gigs with performance data
 */
const getSellerGigs = async (req, res) => {
  try {
    const userId = req.user._id;
    const { limit = 10, page = 1 } = req.query;

    const skip = (page - 1) * limit;

    const [gigs, total] = await Promise.all([
      Gig.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Gig.countDocuments({ userId }),
    ]);

    // For each gig, calculate stats (placeholders - should query Orders)
    const gigsWithStats = gigs.map((gig) => ({
      ...gig,
      views: Math.floor(Math.random() * 500) + 50, // Placeholder
      orders: Math.floor(Math.random() * 20), // Placeholder
      conversionRate: Math.floor(Math.random() * 10) + 1, // Placeholder
    }));

    res.json({
      success: true,
      data: gigsWithStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error getting seller gigs:", error);
    res.status(500).json({ success: false, message: "Failed to fetch gigs" });
  }
};

/**
 * GET /dashboard/seller/earnings
 * Get seller's earnings data for chart
 */
const getSellerEarnings = async (req, res) => {
  try {
    const userId = req.user._id;
    const { period = "30d" } = req.query;

    let days = 30;
    if (period === "7d") days = 7;
    if (period === "90d") days = 90;
    if (period === "1y") days = 365;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get earnings by day
    const earningsByDay = await Order.aggregate([
      {
        $match: {
          sellerId: userId,
          status: "completed",
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$completedAt" },
          },
          amount: { $sum: "$sellerEarnings" },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    // Generate all days in range
    const allDays = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
      allDays.push(dateStr);
    }

    // Map to chart format
    const chartData = allDays.map((date) => {
      const dayData = earningsByDay.find((e) => e._id === date);
      return {
        date,
        amount: dayData?.amount || 0,
      };
    });

    // Calculate totals
    const totalEarnings = chartData.reduce((sum, d) => sum + d.amount, 0);
    const avgDaily = totalEarnings / days;

    res.json({
      success: true,
      data: {
        chart: chartData,
        summary: {
          totalEarnings,
          avgDaily: Math.round(avgDaily * 100) / 100,
          periodDays: days,
        },
      },
    });
  } catch (error) {
    console.error("Error getting seller earnings:", error);
    res.status(500).json({ success: false, message: "Failed to fetch earnings" });
  }
};

/**
 * GET /dashboard/seller/reviews
 * Get seller's reviews
 */
const getSellerReviews = async (req, res) => {
  try {
    const userId = req.user._id;
    const { limit = 10, page = 1 } = req.query;

    const skip = (page - 1) * limit;

    const [reviews, total] = await Promise.all([
      Review.find({ revieweeId: userId, status: "published" })
        .populate("reviewerId", "fullName username profileImage")
        .populate("orderId", "projectTitle")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Review.countDocuments({ revieweeId: userId, status: "published" }),
    ]);

    res.json({
      success: true,
      data: reviews,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error getting seller reviews:", error);
    res.status(500).json({ success: false, message: "Failed to fetch reviews" });
  }
};

// ============================================
// BUYER DASHBOARD APIs
// ============================================

/**
 * GET /dashboard/buyer/stats
 * Get buyer statistics for dashboard
 */
const getBuyerStats = async (req, res) => {
  try {
    const userId = req.user._id;

    // Get active projects count
    const activeProjects = await Project.countDocuments({
      buyerId: userId,
      status: { $in: ["open", "in_progress"] },
    });

    // Get active orders count (as buyer)
    const activeOrders = await Order.countDocuments({
      buyerId: userId,
      status: { $in: ["pending", "active", "in_progress", "review"] },
    });

    // Get open proposals count (for buyer's projects)
    const projectIds = await Project.find({ buyerId: userId }).distinct("_id");
    const openProposals = await Proposal.countDocuments({
      projectId: { $in: projectIds },
      status: { $in: ["submitted", "viewed", "shortlisted"] },
    });

    // Get hired freelancers count
    const hiredFreelancers = await Project.countDocuments({
      buyerId: userId,
      status: "in_progress",
      hiredSellerId: { $exists: true, $ne: null },
    });

    // Calculate total spending this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const spendingThisMonth = await Order.aggregate([
      {
        $match: {
          buyerId: userId,
          status: "completed",
          createdAt: { $gte: startOfMonth },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]);
    const monthlySpending = spendingThisMonth[0]?.total || 0;

    // Get total spending all time
    const totalSpendingAggregation = await Order.aggregate([
      {
        $match: {
          buyerId: userId,
          status: "completed",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]);
    const totalSpending = totalSpendingAggregation[0]?.total || 0;

    // Get wallet balance
    const walletBalance = await Transaction.getUserBalance(userId);

    // Get unread notifications count
    const unreadNotifications = await Notification.getUnreadCount(userId);

    // Get profile completion
    const user = await User.findById(userId).lean();
    let profileCompletion = 0;
    if (user.fullName) profileCompletion += 20;
    if (user.username) profileCompletion += 20;
    if (user.profileImage?.url) profileCompletion += 20;
    if (user.buyerProfile?.company) profileCompletion += 20;
    if (user.buyerProfile?.budgetRange?.min) profileCompletion += 20;

    res.json({
      success: true,
      data: {
        activeProjects,
        activeOrders,
        openProposals,
        hiredFreelancers,
        monthlySpending,
        totalSpending,
        walletBalance,
        unreadNotifications,
        profileCompletion,
      },
    });
  } catch (error) {
    console.error("Error getting buyer stats:", error);
    res.status(500).json({ success: false, message: "Failed to fetch buyer stats" });
  }
};

/**
 * GET /dashboard/buyer/projects
 * Get buyer's projects
 */
const getBuyerProjects = async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, limit = 10, page = 1 } = req.query;

    const query = { buyerId: userId };
    if (status) {
      query.status = status;
    }

    const skip = (page - 1) * limit;

    const [projects, total] = await Promise.all([
      Project.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Project.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: projects,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error getting buyer projects:", error);
    res.status(500).json({ success: false, message: "Failed to fetch projects" });
  }
};

/**
 * GET /dashboard/buyer/orders
 * Get buyer's orders
 */
const getBuyerOrders = async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, limit = 10, page = 1 } = req.query;

    const query = { buyerId: userId };
    if (status) {
      query.status = status;
    } else {
      query.status = { $in: ["pending", "active", "in_progress", "review"] };
    }

    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      Order.find(query)
        .populate("sellerId", "fullName username profileImage sellerProfile")
        .populate("gigId", "title images")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error getting buyer orders:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
};

/**
 * GET /dashboard/buyer/proposals
 * Get proposals for buyer's projects
 */
const getBuyerProposals = async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, limit = 10, page = 1 } = req.query;

    // Get buyer's project IDs
    const projectIds = await Project.find({ buyerId: userId }).distinct("_id");

    const query = { projectId: { $in: projectIds } };
    if (status) {
      query.status = status;
    }

    const skip = (page - 1) * limit;

    const [proposals, total] = await Promise.all([
      Proposal.find(query)
        .populate("sellerId", "fullName username profileImage sellerProfile")
        .populate("projectId", "title budget")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Proposal.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: proposals,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error getting buyer proposals:", error);
    res.status(500).json({ success: false, message: "Failed to fetch proposals" });
  }
};

/**
 * GET /dashboard/buyer/talent
 * Get recommended talent for buyer
 */
const getRecommendedTalent = async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    // Get sellers with completed orders and good ratings
    const sellers = await User.find({
      role: "seller",
      "sellerProfile.skills": { $exists: true, $ne: [] },
      "profileImage.url": { $exists: true },
    })
      .select("fullName username profileImage sellerProfile")
      .limit(parseInt(limit))
      .lean();

    // Get ratings for each seller
    const sellerIds = sellers.map((s) => s._id);
    const reviews = await Review.aggregate([
      { $match: { revieweeId: { $in: sellerIds }, status: "published" } },
      {
        $group: {
          _id: "$revieweeId",
          avgRating: { $avg: "$overallRating" },
          count: { $sum: 1 },
        },
      },
    ]);

    const reviewMap = reviews.reduce((acc, r) => {
      acc[r._id.toString()] = r;
      return acc;
    }, {});

    // Format response
    const talent = sellers.map((seller) => ({
      _id: seller._id,
      name: seller.fullName,
      username: seller.username,
      avatar: seller.profileImage?.url,
      headline: seller.sellerProfile?.bio?.substring(0, 100),
      skills: seller.sellerProfile?.skills || [],
      rating: reviewMap[seller._id.toString()]?.avgRating || 0,
      reviewCount: reviewMap[seller._id.toString()]?.count || 0,
      // Placeholder - would need to query orders to get actual data
      completedProjects: Math.floor(Math.random() * 20) + 5,
      hourlyRate: Math.floor(Math.random() * 100) + 25,
    }));

    res.json({
      success: true,
      data: talent,
    });
  } catch (error) {
    console.error("Error getting recommended talent:", error);
    res.status(500).json({ success: false, message: "Failed to fetch talent" });
  }
};

// ============================================
// SHARED APIs
// ============================================

/**
 * GET /dashboard/recent-activity
 * Get recent activity for user
 */
const getRecentActivity = async (req, res) => {
  try {
    const userId = req.user._id;
    const { limit = 20, category } = req.query;

    const query = { userId };
    if (category) {
      query.category = category;
    }

    const activities = await Activity.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: activities,
    });
  } catch (error) {
    console.error("Error getting recent activity:", error);
    res.status(500).json({ success: false, message: "Failed to fetch activity" });
  }
};

/**
 * GET /dashboard/notifications
 * Get user notifications
 */
const getNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const { unreadOnly, limit = 20, page = 1 } = req.query;

    const query = { userId };
    if (unreadOnly === "true") {
      query.isRead = false;
    }

    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ userId, isRead: false }),
    ]);

    res.json({
      success: true,
      data: notifications,
      unreadCount,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error getting notifications:", error);
    res.status(500).json({ success: false, message: "Failed to fetch notifications" });
  }
};

/**
 * PATCH /dashboard/notifications/:id/read
 * Mark notification as read
 */
const markNotificationRead = async (req, res) => {
  try {
    const userId = req.user._id;
    const { id } = req.params;

    const notification = await Notification.markAsRead(id, userId);

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.json({ success: true, data: notification });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ success: false, message: "Failed to update notification" });
  }
};

/**
 * PATCH /dashboard/notifications/read-all
 * Mark all notifications as read
 */
const markAllNotificationsRead = async (req, res) => {
  try {
    const userId = req.user._id;

    await Notification.markAllAsRead(userId);

    res.json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({ success: false, message: "Failed to update notifications" });
  }
};

/**
 * GET /dashboard/wallet
 * Get wallet info
 */
const getWalletInfo = async (req, res) => {
  try {
    const userId = req.user._id;

    const balance = await Transaction.getUserBalance(userId);

    // Get recent transactions
    const recentTransactions = await Transaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    // Get transaction totals by type
    const totals = await Transaction.aggregate([
      {
        $match: {
          userId,
          status: "completed",
          type: { $in: ["deposit", "earning", "escrow_released"] },
        },
      },
      {
        $group: {
          _id: "$type",
          total: { $sum: "$amount" },
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        balance,
        recentTransactions,
        totals: totals.reduce((acc, t) => {
          acc[t._id] = t.total;
          return acc;
        }, {}),
      },
    });
  } catch (error) {
    console.error("Error getting wallet info:", error);
    res.status(500).json({ success: false, message: "Failed to fetch wallet info" });
  }
};

module.exports = {
  // Seller APIs
  getSellerStats,
  getSellerOrders,
  getSellerGigs,
  getSellerEarnings,
  getSellerReviews,
  // Buyer APIs
  getBuyerStats,
  getBuyerProjects,
  getBuyerOrders,
  getBuyerProposals,
  getRecommendedTalent,
  // Shared APIs
  getRecentActivity,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getWalletInfo,
};