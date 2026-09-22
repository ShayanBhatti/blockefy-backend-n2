const express = require("express");
const authenticate = require("../middleware/authenticate");
const authorizeRole = require("../middleware/authorizeRole");
const validateObjectId = require("../middleware/validateObjectId");
const milestoneController = require("../controllers/milestoneController");

const router = express.Router();

router.use(authenticate);

// POST /api/projects/:projectId/milestones - freelancer creates a milestone (on-chain)
router.post(
  "/projects/:projectId/milestones",
  validateObjectId("projectId"),
  authorizeRole("seller"),
  milestoneController.createMilestone
);

// GET /api/projects/:projectId/milestones - list project milestones
router.get(
  "/projects/:projectId/milestones",
  validateObjectId("projectId"),
  milestoneController.listForProject
);

// GET /api/milestones?role=buyer|seller&status= - list my milestones
router.get("/milestones", milestoneController.listMine);

// POST /api/milestones/:milestoneId/submit - freelancer submits work (on-chain complete)
router.post(
  "/milestones/:milestoneId/submit",
  validateObjectId("milestoneId"),
  authorizeRole("seller"),
  milestoneController.submitMilestone
);

// POST /api/milestones/:milestoneId/resubmit - freelancer resubmits after revision
router.post(
  "/milestones/:milestoneId/resubmit",
  validateObjectId("milestoneId"),
  authorizeRole("seller"),
  milestoneController.resubmitMilestone
);

// POST /api/milestones/:milestoneId/approve - buyer approves + releases payment
router.post(
  "/milestones/:milestoneId/approve",
  validateObjectId("milestoneId"),
  authorizeRole("buyer"),
  milestoneController.approveMilestone
);

// POST /api/milestones/:milestoneId/revision - buyer requests changes
router.post(
  "/milestones/:milestoneId/revision",
  validateObjectId("milestoneId"),
  authorizeRole("buyer"),
  milestoneController.requestRevision
);

module.exports = router;