const asyncHandler = require("../utils/asyncHandler");
const escrowService = require("../services/escrow.service");
const { getOwnedProject } = require("../services/project.service");
const Milestone = require("../models/Milestone");

const getState = asyncHandler(async (req, res) => {
  const result = await escrowService.getEscrowState({ projectId: req.params.projectId });
  res.json({ success: true, data: result });
});

const createDeposit = asyncHandler(async (req, res) => {
  const project = await getOwnedProject({ projectId: req.params.projectId, user: req.authUser });
  const result = await escrowService.createDeposit({
    project,
    user: req.authUser,
    milestoneId: req.body.milestoneId,
    amountEth: req.body.amountEth,
  });
  res.status(201).json({ success: true, data: result });
});

const confirmDeposit = asyncHandler(async (req, res) => {
  const project = await getOwnedProject({ projectId: req.params.projectId, user: req.authUser });
  const result = await escrowService.confirmDeposit({
    project,
    user: req.authUser,
    milestoneId: req.body.milestoneId,
    txHash: req.body.txHash,
  });
  res.json({ success: true, data: result });
});

/**
 * Time-based release: lets the freelancer (or client) trigger the release of
 * the current submitted milestone once the review window lapsed. The scheduler
 * job reuses the same service call.
 */
const release = asyncHandler(async (req, res) => {
  const project = await getOwnedProject({ projectId: req.params.projectId, user: req.authUser });
  const milestone = await Milestone.findOne({ projectId: project._id, status: "submitted" })
    .sort({ createdAt: 1 })
    .populate("projectId")
    .populate("buyerId")
    .populate("sellerId");
  if (!milestone) {
    return res.status(409).json({ success: false, message: "No submitted milestone to release", code: "INVALID_STATE" });
  }
  const result = await escrowService.releaseMilestone({ milestone, project, actorKey: null });
  res.json({ success: true, data: result });
});

const refund = asyncHandler(async (req, res) => {
  const project = await getOwnedProject({ projectId: req.params.projectId, user: req.authUser });
  const result = await escrowService.refund({
    project,
    user: req.authUser,
    reason: req.body.reason,
  });
  res.json({ success: true, data: result });
});

const openDispute = asyncHandler(async (req, res) => {
  const project = await getOwnedProject({ projectId: req.params.projectId, user: req.authUser });
  const result = await escrowService.openDispute({
    project,
    adminKey: req.body.adminKey || null,
    reason: req.body.reason,
  });
  res.json({ success: true, data: result });
});

const resolveDispute = asyncHandler(async (req, res) => {
  const project = await getOwnedProject({ projectId: req.params.projectId, user: req.authUser });
  const result = await escrowService.resolveDispute({
    project,
    adminKey: req.body.adminKey || null,
    toFreelancer: req.body.toFreelancer,
  });
  res.json({ success: true, data: result });
});

module.exports = {
  getState,
  createDeposit,
  confirmDeposit,
  release,
  refund,
  openDispute,
  resolveDispute,
};