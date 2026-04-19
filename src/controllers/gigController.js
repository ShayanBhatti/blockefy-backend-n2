const User = require("../models/User");
const Gig = require("../models/Gig");

exports.createGig = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { title, description, category, tags, pricing, deliveryTime } = req.body;

    // Validate required fields
    if (!title || !description) {
      return res.status(400).json({ error: "Title and description are required" });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // Check if user is a seller
    if (user.role !== "seller") {
      return res.status(403).json({ error: "Not a seller" });
    }

    // If user is on step 4 of onboarding, advance to step 5
    if (user.onboardingStep === 4) {
      user.onboardingStep = 5;
      await user.save();
    }

    // Create gig
    const gig = await Gig.create({
      userId,
      title: title.trim(),
      description: description.trim(),
      category: category ? category.trim() : null,
      tags: tags || [],
      pricing: pricing || {},
      deliveryTime: deliveryTime || null,
    });

    res.status(201).json(gig);
  } catch (error) {
    console.error("Gig creation error:", error);
    res.status(500).json({ error: "Server error" });
  }
};
