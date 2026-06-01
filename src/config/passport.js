const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;
const User = require("../models/User");
const authService = require("../services/authService");

// Dynamic callback URL based on environment
const getCallbackURL = (provider) => {
  const baseURL = process.env.BASE_URL || "http://localhost:7980";
  return `${baseURL}/auth/${provider}/callback`;
};

// ============================================================================
// GOOGLE OAUTH STRATEGY
// Implements unified provider linking
// ============================================================================
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: getCallbackURL("google"),
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value || null;

        // Extract Google profile data
        const providerData = {
          provider: "google",
          email,
          googleId: profile.id,
          fullName: profile.displayName || "Google User",
          username: null, // Google doesn't provide username; will be auto-generated
        };

        // Use centralized provider linking logic
        const result = await authService.handleProviderLogin(providerData);
        const user = result.user;

        // Log the outcome
        if (result.isNewUser) {
          authService.logAuthEvent("Google OAuth - new account created", {
            userId: user._id,
            email: user.email,
          });
        } else if (result.providerLinked) {
          authService.logAuthEvent("Google OAuth - provider linked", {
            userId: user._id,
            email: user.email,
            isNewLink: !profile.id, // Would indicate existing provider
          });
        }

        return done(null, user);
      } catch (error) {
        authService.logAuthEvent("Google OAuth error", {
          error: error.message,
        });
        return done(error, null);
      }
    }
  )
);

// ============================================================================
// GITHUB OAUTH STRATEGY
// Implements unified provider linking
// ============================================================================
passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: getCallbackURL("github"),
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Fetch emails from GitHub API using the access token
        const emailResponse = await fetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        });

        const emails = await emailResponse.json();

        // Find the primary email (or first verified email)
        const primaryEmailObj =
          emails.find(
            (emailObj) =>
              emailObj.primary === true && emailObj.verified === true
          ) || emails.find((emailObj) => emailObj.verified === true);

        const email = primaryEmailObj?.email || null;

        // Extract GitHub profile data
        const providerData = {
          provider: "github",
          email,
          githubId: profile.id,
          fullName: profile.displayName || "GitHub User",
          username: profile.username || profile.login || null,
        };

        // Use centralized provider linking logic
        const result = await authService.handleProviderLogin(providerData);
        const user = result.user;

        // Log the outcome
        if (result.isNewUser) {
          authService.logAuthEvent("GitHub OAuth - new account created", {
            userId: user._id,
            email: user.email,
          });
        } else if (result.providerLinked) {
          authService.logAuthEvent("GitHub OAuth - provider linked", {
            userId: user._id,
            email: user.email,
          });
        }

        return done(null, user);
      } catch (error) {
        authService.logAuthEvent("GitHub OAuth error", {
          error: error.message,
        });
        return done(error, null);
      }
    }
  )
);

// Serialize user for session
passport.serializeUser((user, done) => {
  done(null, user._id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

module.exports = passport;
