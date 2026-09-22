const express = require("express");
const authenticate = require("../middleware/authenticate");
const authorizeRole = require("../middleware/authorizeRole");
const validateObjectId = require("../middleware/validateObjectId");
const proposalController = require("../controllers/proposalController");

const router = express.Router();

router.use(authenticate);

// POST /api/projects/:projectId/proposals - seller submits a proposal
router.post(
  "/projects/:projectId/proposals",
  validateObjectId("projectId"),
  authorizeRole("seller"),
  proposalController.createProposal
);

// GET /api/projects/:projectId/proposals - proposals for a project (buyer/admin/assigned)
router.get(
  "/projects/:projectId/proposals",
  validateObjectId("projectId"),
  proposalController.listForProject
);

// GET /api/proposals?role=buyer|seller&status= - list my proposals
router.get("/proposals", proposalController.listMine);

// GET /api/proposals/:proposalId - proposal detail
router.get("/proposals/:proposalId", validateObjectId("proposalId"), proposalController.getProposalDetail);

// PUT /api/proposals/:proposalId - seller edits + resubmits
router.put(
  "/proposals/:proposalId",
  validateObjectId("proposalId"),
  authorizeRole("seller"),
  proposalController.updateProposal
);

// POST /api/proposals/:proposalId/withdraw - seller withdraws
router.post(
  "/proposals/:proposalId/withdraw",
  validateObjectId("proposalId"),
  authorizeRole("seller"),
  proposalController.withdrawProposal
);

// POST /api/proposals/:proposalId/accept - buyer accepts (assigns on-chain)
router.post(
  "/proposals/:proposalId/accept",
  validateObjectId("proposalId"),
  authorizeRole("buyer"),
  proposalController.acceptProposal
);

// POST /api/proposals/:proposalId/reject - buyer rejects
router.post(
  "/proposals/:proposalId/reject",
  validateObjectId("proposalId"),
  authorizeRole("buyer"),
  proposalController.rejectProposal
);

// POST /api/proposals/:proposalId/revise - buyer requests revision (back to seller)
router.post(
  "/proposals/:proposalId/revise",
  validateObjectId("proposalId"),
  authorizeRole("buyer"),
  proposalController.requestRevision
);

module.exports = router;