const asyncHandler = require("../utils/asyncHandler");
const proposalService = require("../services/proposal.service");

const createProposal = asyncHandler(async (req, res) => {
  const result = await proposalService.createProposal({
    user: req.authUser,
    projectId: req.params.projectId,
    body: req.body,
  });
  res.status(201).json({ success: true, data: result });
});

const listForProject = asyncHandler(async (req, res) => {
  const result = await proposalService.listForProject({
    projectId: req.params.projectId,
    user: req.authUser,
  });
  res.json({ success: true, data: result });
});

const listMine = asyncHandler(async (req, res) => {
  const result = await proposalService.listMine({
    user: req.authUser,
    role: req.query.role,
    status: req.query.status,
  });
  res.json({ success: true, data: result });
});

const getProposalDetail = asyncHandler(async (req, res) => {
  const result = await proposalService.getProposalDetail({
    user: req.authUser,
    proposalId: req.params.proposalId,
  });
  res.json({ success: true, data: result });
});

const acceptProposal = asyncHandler(async (req, res) => {
  const result = await proposalService.acceptProposal({
    user: req.authUser,
    proposalId: req.params.proposalId,
  });
  res.json({ success: true, data: result });
});

const rejectProposal = asyncHandler(async (req, res) => {
  const result = await proposalService.rejectProposal({
    user: req.authUser,
    proposalId: req.params.proposalId,
    reason: req.body.reason,
  });
  res.json({ success: true, data: result });
});

const requestRevision = asyncHandler(async (req, res) => {
  const result = await proposalService.requestRevision({
    user: req.authUser,
    proposalId: req.params.proposalId,
    reason: req.body.reason,
  });
  res.json({ success: true, data: result });
});

const withdrawProposal = asyncHandler(async (req, res) => {
  const result = await proposalService.withdrawProposal({
    user: req.authUser,
    proposalId: req.params.proposalId,
  });
  res.json({ success: true, data: result });
});

const updateProposal = asyncHandler(async (req, res) => {
  const result = await proposalService.updateProposal({
    user: req.authUser,
    proposalId: req.params.proposalId,
    body: req.body,
  });
  res.json({ success: true, data: result });
});

module.exports = {
  createProposal,
  listForProject,
  listMine,
  getProposalDetail,
  acceptProposal,
  rejectProposal,
  requestRevision,
  withdrawProposal,
  updateProposal,
};