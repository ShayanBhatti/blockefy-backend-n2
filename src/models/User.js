const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      unique: true,
      sparse: true, // Allow multiple null values (for wallet-only users)
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      // Optional - only for email/password auth
    },
    fullName: {
      type: String,
      trim: true,
    },
    username: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ["buyer", "seller"],
      default: "buyer",
    },
    // ============================================================================
    // BACKWARD COMPATIBILITY: Keep authProvider for existing code
    // SOURCE OF TRUTH IS NOW authProviders object below
    // ============================================================================
    authProvider: {
      type: String,
      enum: ["email", "google", "github", "wallet"],
      // No longer required - will be derived from authProviders
    },

    // ============================================================================
    // NEW: Multi-Provider Support
    // This object is the authoritative source for provider information
    // ============================================================================
    authProviders: {
      email: {
        connected: {
          type: Boolean,
          default: false,
        },
        connectedAt: {
          type: Date,
          default: null,
        },
      },
      google: {
        connected: {
          type: Boolean,
          default: false,
        },
        googleId: {
          type: String,
          default: null,
        },
        connectedAt: {
          type: Date,
          default: null,
        },
      },
      github: {
        connected: {
          type: Boolean,
          default: false,
        },
        githubId: {
          type: String,
          default: null,
        },
        connectedAt: {
          type: Date,
          default: null,
        },
      },
      wallet: {
        connected: {
          type: Boolean,
          default: false,
        },
        walletAddress: {
          type: String,
          default: null,
          lowercase: true,
          trim: true,
        },
        connectedAt: {
          type: Date,
          default: null,
        },
      },
    },

    // ============================================================================
    // DEPRECATED FIELDS (kept for backward compatibility, use authProviders instead)
    // ============================================================================
    googleId: {
      type: String,
      sparse: true,
    },
    githubId: {
      type: String,
      sparse: true,
    },
    walletAddress: {
      type: String,
      unique: true,
      sparse: true, // Allow multiple null values
      lowercase: true,
      trim: true,
    },
    walletPrivateKey: {
      type: String,
      // Should be encrypted before storing
      // Never send this in responses
    },
    onboardingStep: {
      type: Number,
      default: 0,
    },
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },
    completedSteps: {
      type: [Number],
      default: [],
      // Array of completed and verified onboarding steps
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    emailOtp: {
      type: String,
      default: null,
      // 6-digit OTP for email verification
    },
    emailOtpExpires: {
      type: Date,
      default: null,
      // OTP expiry timestamp (15 minutes from generation)
    },
    emailOtpAttempts: {
      type: Number,
      default: 0,
      // Tracks failed OTP verification attempts for brute-force prevention
    },
    otpSendAttempts: {
      type: [Date],
      default: [],
      // Array of timestamps for rate limiting OTP sends (max 3 per hour)
    },
    lastOtpSentAt: {
      type: Date,
      default: null,
      // Timestamp of last OTP send for 60-second cooldown enforcement
    },
    phoneNumber: {
      type: String,
      default: null,
    },
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    walletNonce: {
      type: String,
      default: null,
      // Nonce for wallet signature verification
    },
    walletNonceExpires: {
      type: Date,
      default: null,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    isIdVerified: {
      type: Boolean,
      default: false,
    },
    description: {
      type: String,
      trim: true,
    },
    // Cloudinary image metadata - uploaded via separate upload endpoints
    profileImage: {
      url: {
        type: String,
        default: null,
      },
      publicId: {
        type: String,
        default: null,
      },
      _id: false, // Prevent Mongoose from creating ID for subdocument
    },
    coverImage: {
      url: {
        type: String,
        default: null,
      },
      publicId: {
        type: String,
        default: null,
      },
      _id: false, // Prevent Mongoose from creating ID for subdocument
    },
    // User profile information
    profile: {
      avatar: {
        type: String,
        default: null,
      },
      coverPhoto: {
        type: String,
        default: null,
      },
      headline: {
        type: String,
        default: null,
      },
      tagline: {
        type: String,
        default: null,
      },
      about: {
        type: String,
        default: null,
      },
    },

    // Seller-specific profile
    sellerProfile: {
      bio: {
        type: String,
        default: null,
      },
      skills: {
        type: [String],
        default: [],
      },
      experience: [
        {
          title: {
            type: String,
            required: true,
          },
          company: {
            type: String,
            required: true,
          },
          startDate: {
            type: Date,
            required: true,
          },
          endDate: {
            type: Date,
            default: null,
          },
          description: {
            type: String,
            default: null,
          },
          _id: false,
        },
      ],
      education: [
        {
          school: {
            type: String,
            required: true,
          },
          degree: {
            type: String,
            required: true,
          },
          startYear: {
            type: Number,
            required: true,
          },
          endYear: {
            type: Number,
            default: null,
          },
          _id: false,
        },
      ],
      portfolio: [
        {
          title: {
            type: String,
            required: true,
          },
          description: {
            type: String,
            default: null,
          },
          image: {
            type: String,
            default: null,
          },
          link: {
            type: String,
            default: null,
          },
          _id: false,
        },
      ],
      languages: {
        type: [String],
        default: [],
      },
    },

    // Buyer-specific profile
    buyerProfile: {
      company: {
        type: String,
        default: null,
      },
      interests: {
        type: [String],
        default: [],
      },
      budgetRange: {
        min: {
          type: Number,
          default: null,
        },
        max: {
          type: Number,
          default: null,
        },
      },
      preferredCategories: {
        type: [String],
        default: [],
      },
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
    verificationDocument: {
      type: {
        type: String,
        default: null,
      },
      image: {
        url: { type: String, default: null },
        publicId: { type: String, default: null },
        _id: false // Prevent Mongoose from creating ID for subdocument
      }
    }
  },
  {
    timestamps: true // Adds updatedAt field
  }
);

// Prevent model overwrite in serverless
const User = mongoose.models.User || mongoose.model("User", userSchema);

module.exports = User;
