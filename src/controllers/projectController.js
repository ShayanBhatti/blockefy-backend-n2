const asyncHandler = require("../utils/asyncHandler");
const projectService = require("../services/project.service");

const createProject = asyncHandler(async (req, res) => {
  const result = await projectService.createProject({ user: req.authUser, body: req.body });
  res.status(201).json({ success: true, data: result });
});

const confirmOnChainProject = asyncHandler(async (req, res) => {
  const result = await projectService.confirmOnChainProject({
    user: req.authUser,
    projectId: req.params.projectId,
    txHash: req.body.txHash,
  });
  res.json({ success: true, data: result });
});

const listProjects = asyncHandler(async (req, res) => {
  const result = await projectService.listProjects({
    user: req.authUser,
    role: req.query.role,
    status: req.query.status,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.json({ success: true, data: result });
});

const getProject = asyncHandler(async (req, res) => {
  const result = await projectService.getProject({
    user: req.authUser,
    projectId: req.params.projectId,
  });
  res.json({ success: true, data: result });
});

const updateProject = asyncHandler(async (req, res) => {
  const project = await projectService.getOwnedProject({
    projectId: req.params.projectId,
    user: req.authUser,
  });
  if (String(project.buyerId?._id || project.buyerId) !== String(req.authUser._id) && req.authUser.role !== "admin") {
    return res.status(403).json({ success: false, message: "Not authorized", code: "FORBIDDEN" });
  }
  if (!["draft", "open"].includes(project.status)) {
    return res.status(409).json({ success: false, message: "Cannot update project in this state", code: "INVALID_STATE" });
  }
  const allowed = ["title", "description", "category", "subcategory", "skills", "duration", "deadline", "visibility"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) project[key] = req.body[key];
  }
  if (req.body.budget && req.body.budget.max) {
    project.budget = { min: req.body.budget.min || 0, max: req.body.budget.max, currency: req.body.currency || "ETH" };
  }
  await project.save();
  res.json({ success: true, data: { project } });
});

const cancelProject = asyncHandler(async (req, res) => {
  const result = await projectService.cancelProject({
    user: req.authUser,
    projectId: req.params.projectId,
    reason: req.body.reason,
  });
  res.json({ success: true, data: result });
});

module.exports = {
  createProject,
  confirmOnChainProject,
  listProjects,
  getProject,
  updateProject,
  cancelProject,
};