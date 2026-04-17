const mongoose = require("mongoose"); 

/**
 * Serverless-safe MongoDB connection with global caching
 * Prevents multiple connections on Vercel
 */
async function connectDB() {
  // Return cached connection if it exists
  if (global.mongoose && global.mongoose.conn) {
    console.log("Using cached MongoDB connection");
    return global.mongoose.conn;
  }

  // Initialize cache object if needed
  if (!global.mongoose) {
    global.mongoose = { conn: null };
  }

  try {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
      throw new Error("MONGODB_URI environment variable is not defined");
    }

    // Connection options for serverless
    const options = {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      maxPoolSize: 1, // Serverless needs minimal pool
      retryWrites: false, // Simplify for serverless
    };

    console.log("Connecting to MongoDB...");
    const conn = await mongoose.connect(uri, options);

    // Cache the connection
    global.mongoose.conn = conn;

    console.log(`MongoDB connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    // Don't exit process - serverless cannot restart
    throw error;
  }
}

module.exports=connectDB;
