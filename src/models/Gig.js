const mongoose = require("mongoose");
const { REQUIREMENT_TYPES_VALUES } = require("../constants/order.constants");

/**
 * Order-system extensions to the Gig model.
 *
 * Existing fields (userId, title, description, status, category, tags,
 * pricing.basic/standard/premium, deliveryTime, gigImage) are preserved so the
 * existing gig management + dashboard code keeps working.
 *
 * New fields (packages, extras, requirements) give gigs the structure the
 * Order Management System needs. Legacy `pricing.*` and `deliveryTime` are
 * treated as a fallback representation when a gig predates packages.
 */

const packageSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    price: { type: Number, required: true, min: 0 },
    description: { type: String, trim: true, default: "" },
    deliveryDays: { type: Number, required: true, min: 1 },
    // Number of revisions included. Use -1 for unlimited.
    revisions: { type: Number, default: 0, min: -1 },
    features: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { _id: true }
);

const extraSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    description: { type: String, trim: true, default: "" },
    price: { type: Number, required: true, min: 0 },
    // Days ADDED to the delivery time (delivery-extension model).
    deliveryDays: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true }
);

const requirementSchema = new mongoose.Schema(
  {
    question: { type: String, trim: true, required: true },
    type: { type: String, enum: REQUIREMENT_TYPES_VALUES, required: true },
    required: { type: Boolean, default: false },
    options: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { _id: true }
);

const gigSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["draft", "posted"],
      default: "draft",
    },
    category: {
      type: String,
      trim: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    // Legacy pricing — keep for backward compatibility.
    pricing: {
      basic: { type: Number, min: 0 },
      standard: { type: Number, min: 0 },
      premium: { type: Number, min: 0 },
    },
    // Legacy single delivery time in days.
    deliveryTime: { type: Number, min: 1 },
    // New: package-based pricing model (source of truth when present).
    packages: { type: [packageSchema], default: [] },
    // New: optional add-on extras.
    extras: { type: [extraSchema], default: [] },
    // New: optional seller-defined buyer requirements.
    requirements: { type: [requirementSchema], default: [] },
    // Image storage - Cloudinary URL and publicId
    gigImage: { type: String, default: null },
    gigImagePublicId: { type: String, default: null },
  },
  { timestamps: true }
);

/**
 * Resolve a package from a gig.
 *
 * @param {Object} gig - Gig document
 * @param {String|ObjectId} packageId - packages[]._id, or a legacy key
 *   ("basic" | "standard" | "premium").
 * @returns {Object|null} package record (for legacy gigs a synthesized object
 *   is returned) or null when not found.
 */
gigSchema.statics.resolvePackage = function (gig, packageId) {
  if (!gig || !packageId) return null;
  const pid = String(packageId);

  // New packages array.
  if (Array.isArray(gig.packages) && gig.packages.length > 0) {
    const pkg = gig.packages.find(
      (p) => p._id && (String(p._id) === pid || String(p._id) === String(packageId))
    );
    if (!pkg) return null;
    return {
      packageId: pkg._id,
      name: pkg.name,
      price: pkg.price,
      description: pkg.description,
      deliveryDays: pkg.deliveryDays,
      revisions: pkg.revisions,
      features: pkg.features,
    };
  }

  // Legacy pricing fallback.
  const legacyKeys = ["basic", "standard", "premium"];
  if (!legacyKeys.includes(pid)) return null;
  const price = gig.pricing && gig.pricing[pid];
  if (price === undefined || price === null) return null;
  return {
    packageId: pid,
    name: pid.charAt(0).toUpperCase() + pid.slice(1),
    price,
    description: "",
    deliveryDays: gig.deliveryTime || 1,
    revisions: 0,
    features: [],
  };
};

/**
 * Resolve extras for a gig by ids.
 *
 * @param {Object} gig - Gig document
 * @param {Array} extraIds - array of extras[]._id
 * @returns {Array} matching active extras with snapshot fields
 */
gigSchema.statics.resolveExtras = function (gig, extraIds) {
  if (!gig || !Array.isArray(extraIds)) return [];
  if (!Array.isArray(gig.extras) || gig.extras.length === 0) return [];

  const seen = new Set();
  const result = [];
  for (const id of extraIds) {
    if (id === undefined || id === null) continue;
    const sid = String(id);
    if (seen.has(sid)) continue;
    const extra = gig.extras.find(
      (e) => e._id && (String(e._id) === sid || String(e._id) === String(id))
    );
    if (extra && extra.isActive !== false) {
      seen.add(sid);
      result.push({
        extraId: extra._id,
        name: extra.name,
        description: extra.description,
        price: extra.price,
        deliveryDays: extra.deliveryDays,
      });
    }
  }
  return result;
};

// Prevent model overwrite in serverless
const Gig = mongoose.models.Gig || mongoose.model("Gig", gigSchema);

module.exports = Gig;
