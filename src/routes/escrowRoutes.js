const express = require("express");
const authenticate = require("../middleware/authenticate");
const authorizeRole = require("../middleware/authorizeRole");
const validateObjectId = require("../middleware/validateObjectId");
const escrowController = require("../controllers/escrowController");
const smartContractController = require("../controllers/smartContractController");

const router = express.Router();

router.use(authenticate);

// ---------------------------------------------------------------------------
// Escrow flows
// ---------------------------------------------------------------------------

// GET /api/escrow/projects/:projectId - escrow + milestone funding state
router.get(
  "/escrow/projects/:projectId",
  validateObjectId("projectId"),
  escrowController.getState
);

// POST /api/escrow/projects/:projectId/deposit - prepare client-signed deposit
router.post(
  "/escrow/projects/:projectId/deposit",
  validateObjectId("projectId"),
  authorizeRole("buyer"),
  escrowController.createDeposit
);

// POST /api/escrow/projects/:projectId/deposit/confirm - finalize after wallet tx
router.post(
  "/escrow/projects/:projectId/deposit/confirm",
  validateObjectId("projectId"),
  authorizeRole("buyer"),
  escrowController.confirmDeposit
);

// POST /api/escrow/projects/:projectId/release - trigger time-based release
router.post(
  "/escrow/projects/:projectId/release",
  validateObjectId("projectId"),
  escrowController.release
);

// POST /api/escrow/projects/:projectId/refund - refund escrow after deadline
router.post(
  "/escrow/projects/:projectId/refund",
  validateObjectId("projectId"),
  authorizeRole("buyer"),
  escrowController.refund
);

// POST /api/escrow/projects/:projectId/dispute - admin opens a dispute
router.post(
  "/escrow/projects/:projectId/dispute",
  validateObjectId("projectId"),
  authorizeRole("admin"),
  escrowController.openDispute
);

// POST /api/escrow/projects/:projectId/dispute/resolve - admin resolves a dispute
router.post(
  "/escrow/projects/:projectId/dispute/resolve",
  validateObjectId("projectId"),
  authorizeRole("admin"),
  escrowController.resolveDispute
);

// ---------------------------------------------------------------------------
// Generic contract access
// ---------------------------------------------------------------------------

// GET /api/contract/status - chain / contract health info
router.get("/contract/status", smartContractController.getContractInfo);

// GET /api/contract/projects/:projectId - on-chain project state
router.get(
  "/contract/projects/:projectId",
  validateObjectId("projectId"),
  smartContractController.getProjectState
);

// POST /api/contract/relay - whitelisted non-payable relay (escape hatch)
router.post("/contract/relay", smartContractController.relay);

module.exports = router;