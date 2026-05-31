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
        let user = await User.findOne({ googleId: profile.id });

        if (user) {
          return done(null, user);
        }

        const email = profile.emails?.[0]?.value || null;
        const baseUsername = email ? email.split("@")[0] : "google_user";
        const username = `${baseUsername}_${profile.id.slice(-4)}`;

        user = new User({
          fullname: profile.displayName || "Google User",
          username: username,
          email: email,
          googleId: profile.id,
          authProvider: "google",
          role: "buyer",
          emailVerified: true,
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
        // First, check if user exists by githubId
        let user = await User.findOne({ githubId: profile.id });

        if (user) {
          return done(null, user);
        }

        // Fetch emails from GitHub API using the access token
        const emailResponse = await fetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        });

        const emails = await emailResponse.json();
        
        // Find the primary email (or first verified email)
        const primaryEmailObj = emails.find(
          (emailObj) => emailObj.primary === true && emailObj.verified === true
        ) || emails.find((emailObj) => emailObj.verified === true);

        const email = primaryEmailObj?.email || null;

        // Get username from profile (profile.username or profile.login)
        const username = profile.username || profile.login || `github_${profile.id}`;

        // Create new user
        user = new User({
          fullname: profile.displayName || "GitHub User",
          username: username,
          email: email,
          githubId: profile.id,
          authProvider: "github",
          role: "buyer",
          emailVerified: true, // GitHub verified emails are trusted
        });

        await user.save();
        return done(null, user);
      } catch (error) {
        console.error("GitHub OAuth error:", error);
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
