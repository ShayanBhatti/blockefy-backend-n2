const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;
const User = require("../models/User");

// Dynamic callback URL based on environment
const getCallbackURL = (provider) => {
  const baseURL = process.env.BASE_URL || "http://localhost:7980";
  return `${baseURL}/auth/${provider}/callback`;
};

// Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: getCallbackURL("google"),
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user exists
        let user = await User.findOne({ googleId: profile.id });

        if (user) {
          return done(null, user);
        }

        // Create new user
        user = new User({
          email: profile.emails?.[0]?.value,
          googleId: profile.id,
          authProvider: "google",
          role: "buyer",
          emailVerified: true, // OAuth users are automatically verified
        });

        await user.save();
        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

// GitHub OAuth Strategy
passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: getCallbackURL("github"),
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user exists
        let user = await User.findOne({ githubId: profile.id });

        if (user) {
          return done(null, user);
        }

        // Create new user
        user = new User({
          email: profile.emails?.[0]?.value,
          githubId: profile.id,
          authProvider: "github",
          role: "buyer",
          emailVerified: true, // OAuth users are automatically verified
        });

        await user.save();
        return done(null, user);
      } catch (error) {
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
