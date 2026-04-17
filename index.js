require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 7980;

// 4. Middleware
app.use(cors({ origin: "*" }));
app.use(express.json());

// 5. Routes
app.get("/", (req, res) => {
  res.send("Blockefy Backend is running!");
});

// 6. Start the server (Local development)
app.listen(port, () => {
  console.log(`Server running at ${port}`);
});

// 7. Export for Vercel (This replaces "export default app")
module.exports = app;
