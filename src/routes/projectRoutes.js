const express = require("express");
const authenticate = require("../middleware/authenticate");
const authorizeRole = require("../middleware/authorizeRole");
const validateObjectId = require("../middleware/validateObjectId");
const projectController = require("../controllers/projectController");

const router = express.Router();

// All project routes require authentication.
router.use(authenticate);

// POST /api/projects - client creates a project (pushed on-chain when possible)
router.post("/projects", authorizeRole("buyer"), projectController.createProject);

// GET /api/projects?role=buyer|seller&status= - list projects for the current user
router.get("/projects", projectController.listProjects);

// POST /api/projects/:projectId/onchain - record a wallet-signed createProject tx
router.post(
  "/projects/:projectId/onchain",
  validateObjectId("projectId"),
  projectController.confirmOnChainProject
);

// PUT /api/projects/:projectId - update open/draft project details
router.put(
  "/projects/:projectId",
  validateObjectId("projectId"),
  projectController.updateProject
);

// POST /api/projects/:projectId/cancel - cancel before any funds are held
router.post(
  "/projects/:projectId/cancel",
  validateObjectId("projectId"),
  projectController.cancelProject
);

// GET /api/projects/:projectId - single project detail
router.get(
  "/projects/:projectId",
  validateObjectId("projectId"),
  projectController.getProject
);

module.exports = router;