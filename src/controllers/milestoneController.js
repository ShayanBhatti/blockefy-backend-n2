const asyncHandler = require("../utils/asyncHandler");
const milestoneService = require("../services/milestone.service");

const createMilestone = asyncHandler(async (req, res) => {
  const result = await milestoneService.createMilestone({
    user: req.authUser,
    projectId: req.params.projectId,
    body: req.body,
  });
  res.status(201).json({ success: true, data: result });
});

const listForProject = asyncHandler(async (req, res) => {
  const result = await milestoneService.listForProject({
    projectId: req.params.projectId,
    user: req.authUser,
  });
  res.json({ success: true, data: result });
});

const listMine = asyncHandler(async (req, res) => {
  const result = await milestoneService.listMine({
    user: req.authUser,
    role: req.query.role,
    status: req.query.status,
  });
  res.json({ success: true, data: result });
});

const submitMilestone = asyncHandler(async (req, res) => {
  const result = await milestoneService.submitMilestone({
    milestoneId: req.params.milestoneId,
    user: req.authUser,
    data: req.body,
  });
  res.json({ success: true, data: result });
});

const resubmitMilestone = asyncHandler(async (req, res) => {
  const result = await milestoneService.resubmitMilestone({
    milestoneId: req.params.milestoneId,
    user: req.authUser,
    data: req.body,
  });
  res.json({ success: true, data: result });
});

const approveMilestone = asyncHandler(async (req, res) => {
  const result = await milestoneService.approveMilestone({
    milestoneId: req.params.milestoneId,
    user: req.authUser,
  });
  res.json({ success: true, data: result });
});

const requestRevision = asyncHandler(async (req, res) => {
  const result = await milestoneService.requestRevision({
    milestoneId: req.params.milestoneId,
    user: req.authUser,
    reason: req.body.reason,
    extraDays: req.body.extraDays,
  });
  res.json({ success: true, data: result });
});

module.exports = {
  createMilestone,
  listForProject,
  listMine,
  submitMilestone,
  resubmitMilestone,
  approveMilestone,
  requestRevision,
};