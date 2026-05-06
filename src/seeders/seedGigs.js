// seedGigs.js
require("dotenv").config();
const mongoose = require("mongoose");

// --- CONFIGURATION ---
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://TestUser:3VneFzE0sLY2biFq@blockefy.hbslfgf.mongodb.net/?appName=Blockefy";
const TARGET_USER_ID = "69f4833c252feae49e888b3a"; // from your user table
const NUMBER_OF_GIGS = 25;

// --- Placeholder Image (1x1 transparent PNG) ---
// Replace this with your own base64 images (up to 3 per gig)
const DEFAULT_IMAGE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function getDefaultImages(isPrimary = true) {
  return [
    {
      data: DEFAULT_IMAGE_URL,
      contentType: "image/png",
      isPrimary,
    },
  ];
}

// --- Helper: Realistic gig data generators ---
const CATEGORIES = [
  "Web Development",
  "Mobile Apps",
  "Graphic Design",
  "Digital Marketing",
  "Writing & Translation",
  "Video & Animation",
  "Music & Audio",
  "Programming & Tech",
  "Business",
  "Lifestyle",
  "Data Science",
  "AI & ML",
];

const TITLES = {
  "Web Development": [
    "Custom WordPress Website",
    "React.js E‑commerce Store",
    "Landing Page with Tailwind",
    "Full‑Stack MERN Application",
    "Portfolio Website with Animations",
    "Shopify Store Setup",
  ],
  "Mobile Apps": [
    "Flutter iOS/Android App",
    "React Native UI/UX Design",
    "App Store Optimization",
    "Cross‑Platform Mobile Game",
    "Fitness Tracking App",
    "Food Delivery App MVP",
  ],
  "Graphic Design": [
    "Minimalist Logo Design",
    "Social Media Carousel Pack",
    "Brand Identity Kit",
    "Product Packaging Mockup",
    "Infographic for Business",
    "YouTube Thumbnail Design",
  ],
  "Digital Marketing": [
    "SEO Audit & Fix",
    "Google Ads Campaign Setup",
    "Social Media Management (1 month)",
    "Email Marketing Automation",
    "Content Marketing Strategy",
    "Facebook Pixel Setup",
  ],
  "Writing & Translation": [
    "Blog Post (1000 words)",
    "Technical Documentation",
    "Proofreading & Editing",
    "Spanish to English Translation",
    "Copywriting for Sales Page",
    "Resume & Cover Letter",
  ],
  "Video & Animation": [
    "Explainer Video (60 sec)",
    "YouTube Intro Animation",
    "TikTok Video Editing",
    "Whiteboard Animation",
    "Product Promo Reel",
    "After Effects Motion Graphics",
  ],
};

const TAGS_MAP = {
  "Web Development": [
    "responsive",
    "javascript",
    "html5",
    "css3",
    "react",
    "nodejs",
  ],
  "Mobile Apps": [
    "flutter",
    "swift",
    "kotlin",
    "firebase",
    "ui/ux",
    "appstore",
  ],
  "Graphic Design": [
    "adobe illustrator",
    "photoshop",
    "minimalist",
    "branding",
    "vector",
  ],
  "Digital Marketing": [
    "seo",
    "google ads",
    "facebook ads",
    "analytics",
    "email",
  ],
  "Writing & Translation": [
    "blog",
    "technical writing",
    "grammar",
    "localization",
  ],
  "Video & Animation": [
    "premiere pro",
    "after effects",
    "voiceover",
    "2d animation",
  ],
};

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomTags(category) {
  const tagPool = TAGS_MAP[category] || [
    "quality",
    "fast delivery",
    "professional",
  ];
  const shuffled = [...tagPool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(3, shuffled.length));
}

function generateGigs(userId, count) {
  const gigs = [];
  for (let i = 1; i <= count; i++) {
    const category = randomItem(CATEGORIES);
    const titlePool = TITLES[category] || [
      `Professional ${category} Service ${i}`,
    ];
    const title =
      randomItem(titlePool) + (i % 3 === 0 ? ` (Package ${i})` : "");
    const description =
      `I will deliver high‑quality ${category.toLowerCase()} tailored to your needs. ` +
      `Includes unlimited revisions, source files, and dedicated support. ${category} experts with 5+ years experience.`;

    const basicPrice = 30 + Math.floor(Math.random() * 120);
    const standardPrice = basicPrice + 50 + Math.floor(Math.random() * 150);
    const premiumPrice = standardPrice + 80 + Math.floor(Math.random() * 200);

    const deliveryTime = Math.floor(Math.random() * 10) + 1; // 1-10 days

    gigs.push({
      userId,
      title,
      description,
      category,
      tags: getRandomTags(category),
      pricing: {
        basic: basicPrice,
        standard: standardPrice,
        premium: premiumPrice,
      },
      deliveryTime,
      images: getDefaultImages(true), // exactly one primary image
    });
  }
  return gigs;
}

// --- Mongoose Model Definition (if not already defined elsewhere) ---
let Gig;
try {
  Gig = mongoose.model("Gig");
} catch (e) {
  const gigSchema = new mongoose.Schema(
    {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
      title: { type: String, required: true, trim: true },
      description: { type: String, required: true, trim: true },
      category: { type: String, trim: true },
      tags: { type: [String], default: [] },
      pricing: {
        basic: { type: Number, min: 0 },
        standard: { type: Number, min: 0 },
        premium: { type: Number, min: 0 },
      },
      deliveryTime: { type: Number },
      images: {
        type: [
          {
            data: { type: String, required: true },
            contentType: { type: String, required: true },
            isPrimary: { type: Boolean, default: false },
          },
        ],
        validate: [(val) => val.length <= 3, "Max 3 images allowed"],
        default: [],
      },
    },
    { timestamps: true },
  );
  Gig = mongoose.model("Gig", gigSchema);
}

// --- Main seeding function ---
async function seedGigs() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    // Generate 25 gigs
    const gigsData = generateGigs(TARGET_USER_ID, NUMBER_OF_GIGS);

    // Insert into DB
    const result = await Gig.insertMany(gigsData);
    console.log(
      `✅ Successfully inserted ${result.length} gigs for user ${TARGET_USER_ID}`,
    );

    // Optional: also export a JSON file for inspection
    const fs = require("fs");
    const jsonOutput = gigsData.map((g) => ({
      ...g,
      userId: g.userId.toString(),
      images: g.images.map((img) => ({
        ...img,
        data: "[BASE64_IMAGE_PLACEHOLDER]",
      })),
    }));
    fs.writeFileSync("gigs-seed.json", JSON.stringify(jsonOutput, null, 2));
    console.log("📄 JSON preview saved to gigs-seed.json (images hidden)");
  } catch (err) {
    console.error("❌ Seeding failed:", err);
  } finally {
    await mongoose.disconnect();
  }
}

seedGigs();
