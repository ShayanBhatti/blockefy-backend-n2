const express = require("express");
const sellerController = require("../controllers/sellerController");

const router = express.Router();

// GET /api/seller?userId=... - public profile by query param
router.get("/", sellerController.getSellerProfile);

// GET /api/seller/:profileId - public profile by path param
router.get("/:profileId", sellerController.getSellerProfile);

module.exports = router;
