const mongoose = require("mongoose");
const Milestone = require("../models/Milestone");
const Project = require("../models/Project");
const AppError = require("../utils/AppError");
const chainService = require("./chain.service");
const escrowService = require("./escrow.service");
const { notifyProject } = require("./notification.service");
const { getOwnedProject, assertRole } = require("./project.service");

/**
 * Milestone service (on-chain escrow).
 *
 * NOTE (contract constraint): `createMilestone` is only permitted by the
 * Blockefy contract while the on-chain project is `Created` or `Funded`. As
 * soon as the client deposits for the first milestone the project flips to
 * `InProgress` and NO further milestones can be added. The app therefore
 * requires the freelancer to create the full milestone plan BEFORE the first
 * deposit.
 */

const getPreferredAmount = (proposal, index) => {
  const plan = proposal.milestones || [];
  if (plan.length > index) return plan[index].amount;
  return null;
};

const milestoneFromDoc = (doc) => {
  if (typeof doc.toObject === "function") return doc.toObject();
  return doc;
};

const getMilestoneById = async ({ milestoneId }) => {
  if (!mongoose.Types.ObjectId.isValid(milestoneId)) {
    throw new AppError("Invalid milestone id", 400, "INVALID_ID");
  }
  const milestone = await Milestone.findById(milestoneId)
    .populate("projectId", "title projectNumber status onChainProjectId buyerId hiredSellerId selectedProposalId")
    .populate("buyerId", "firstName lastName email avatar username")
    .populate("sellerId", "firstName lastName email avatar username");
  if (!milestone) throw new AppError("Milestone not found", 404, "NOT_FOUND");
  return milestone;
};

const assertMilestoneAccess = ({ milestone, user, roles }) => {
  if (user.role === "admin") return;
  const isBuyer = String(milestone.buyerId?._id || milestone.buyerId) === String(user._id);
  const isSeller = String(milestone.sellerId?._id || milestone.sellerId) === String(user._id);
  if (roles.includes("buyer") && isBuyer) return;
  if (roles.includes("seller") && isSeller) return;
  throw new AppError("Not authorized", 403, "FORBIDDEN");
};

const hasFundingStarted = async (projectId) =>
  Milestone.exists({ projectId, paymentStatus: { $in: ["paid", "released"] } });

/**
 * Freelancer creates a milestone (on-chain + Mongo). Only allowed before the
 * first escrow deposit (see contract constraint above).
 */
const createMilestone = async ({ user, projectId, body }) => {
  assertRole(user, "seller", "Only the assigned freelancer can create milestones");
  const project = await getOwnedProject({ projectId, user });
  if (String(project.hiredSellerId || "") !== String(user._id) && user.role !== "admin") {
    throw new AppError("You are not the assigned freelancer on this project", 403, "FORBIDDEN");
  }
  if (project.status !== "in_progress") {
    throw new AppError("Project is not in progress", 409, "INVALID_STATE");
  }
  const amount = Number(body.amount);
  if (!amount || amount <= 0) {
    throw new AppError("Milestone amount must be greater than 0", 400, "VALIDATION");
  }
  if (await hasFundingStarted(project._id)) {
    throw new AppError(
      "All milestones must be created before the first escrow deposit (contract constraint)",
      409,
      "FUNDING_STARTED"
    );
  }
  let onChainMilestoneId = null;
  if (project.onChainProjectId && user.walletPrivateKey) {
    const { receipt } = await chainService.relayCallAs({
      actorKey: user.walletPrivateKey,
      method: "createMilestone",
      args: [project.onChainProjectId, String(body.title || "Milestone").slice(0, 200), chainService.toWei(amount)],
    });
    const created = chainService.parseEventFromReceipt(receipt, "MilestoneCreated");
    onChainMilestoneId = created ? Number(created.args.milestoneId) : await chainService.getMilestoneCounter();
  }

  const milestone = new Milestone({
    milestoneNumber: await Milestone.generateMilestoneNumber(),
    projectId: project._id,
    buyerId: project.buyerId,
    sellerId: user._id,
    title: String(body.title || "Milestone").slice(0, 200),
    description: String(body.description || "").slice(0, 2000),
    amount: Math.round(amount * 100) / 100,
    currency: "ETH",
    dueDate: body.dueDate ? new Date(body.dueDate) : new Date(Date.now() + 7 * 86400000),
    onChainMilestoneId,
    status: "pending",
    deliveryType: "milestone",
  });
  await milestone.save();

  return { milestone: milestoneFromDoc(milestone) };
};

const listForProject = async ({ projectId, user }) => {
  const project = await getOwnedProject({ projectId, user });
  const milestoneDocs = await Milestone.find({ projectId: project._id }).sort({ createdAt: 1 });
  return { milestones: milestoneDocs.map(milestoneFromDoc) };
};

const listMine = async ({ user, role, status }) => {
  const filter = {};
  if (role === "seller") filter.sellerId = user._id;
  else if (role === "buyer") filter.buyerId = user._id;
  else if (role === "admin") {
    // admin sees all
  } else {
    filter.$or = [{ sellerId: user._id }, { buyerId: user._id }];
  }
  if (status) filter.status = status;
  const milestones = await Milestone.find(filter)
    .sort({ createdAt: -1 })
    .populate("projectId", "title projectNumber status")
    .populate("buyerId", "firstName lastName avatar")
    .populate("sellerId", "firstName lastName avatar");
  return { milestones: milestones.map(milestoneFromDoc) };
};

/**
 * Freelancer submits work: marks milestone complete on-chain, records the
 * submission, and opens the buyer review window.
 */
const submitMilestone = async ({ milestoneId, user, data }) => {
  assertRole(user, "seller", "Only the freelancer can submit work");
  const milestone = await getMilestoneById({ milestoneId });
  assertMilestoneAccess({ milestone, user, roles: ["seller"] });
  const project = await Project.findById(milestone.projectId._id || milestone.projectId);
  if (!project?.onChainProjectId) {
    throw new AppError("Project has no on-chain escrow", 409, "NO_ONCHAIN");
  }
  if (milestone.status !== "funded" && milestone.status !== "in_progress") {
    throw new AppError("Milestone must be funded before submitting work", 409, "INVALID_STATE");
  }
  if (String(project.hiredSellerId || "") !== String(milestone.sellerId?._id || milestone.sellerId)) {
    throw new AppError("You are not the assigned freelancer", 403, "FORBIDDEN");
  }

  if (project.onChainProjectId && milestone.onChainMilestoneId && user.walletPrivateKey) {
    await chainService.relayCallAs({
      actorKey: user.walletPrivateKey,
      method: "completeMilestone",
      args: [project.onChainProjectId, milestone.onChainMilestoneId],
    });
  }

  milestone.submission = {
    url: data.url || null,
    description: String(data.description || "").slice(0, 2000),
    files: Array.isArray(data.files) ? data.files : [],
    submittedAt: new Date(),
  };
  milestone.status = "submitted";
  milestone.paymentStatus = milestone.paymentStatus || "paid";
  await milestone.save();

  await notifyProject.milestoneSubmitted(
    milestone.buyerId._id || milestone.buyerId,
    project._id,
    milestone._id
  );

  return { milestone: milestoneFromDoc(milestone) };
};

/**
 * Freelancer re-submits after a revision request. Off-chain only: the contract
 * keeps the milestone in the submitted state until approval.
 */
const resubmitMilestone = async ({ milestoneId, user, data }) => {
  assertRole(user, "seller", "Only the freelancer can resubmit work");
  const milestone = await getMilestoneById({ milestoneId });
  assertMilestoneAccess({ milestone, user, roles: ["seller"] });
  if (milestone.status !== "revision_requested") {
    throw new AppError("Milestone is not under revision", 409, "INVALID_STATE");
  }
  milestone.submission = {
    url: data.url || null,
    description: String(data.description || "").slice(0, 2000),
    files: Array.isArray(data.files) ? data.files : [],
    submittedAt: new Date(),
  };
  milestone.status = "submitted";
  if (milestone.revisionRequests?.length && !milestone.revisionRequests[milestone.revisionRequests.length - 1].resolved) {
    milestone.revisionRequests[milestone.revisionRequests.length - 1].resolved = true;
  }
  await milestone.save();
  const project = await Project.findById(milestone.projectId._id || milestone.projectId);
  await notifyProject.milestoneSubmitted(
    milestone.buyerId._id || milestone.buyerId,
    project._id,
    milestone._id
  );
  return { milestone: milestoneFromDoc(milestone) };
};

/**
 * Buyer approves the delivered work ("no changes required") and the payment is
 * released from escrow to the freelancer.
 */
const approveMilestone = async ({ milestoneId, user }) => {
  assertRole(user, "buyer", "Only the client can approve deliverables");
  const milestone = await getMilestoneById({ milestoneId });
  assertMilestoneAccess({ milestone, user, roles: ["buyer"] });
  const project = await Project.findById(milestone.projectId._id || milestone.projectId);
  if (milestone.status !== "submitted") {
    throw new AppError("Milestone has no pending submission to approve", 409, "INVALID_STATE");
  }
  if (!project?.onChainProjectId || !milestone.onChainMilestoneId) {
    throw new AppError("Milestone has no on-chain reference", 409, "NO_ONCHAIN");
  }

  if (user.walletPrivateKey) {
    await chainService.relayCallAs({
      actorKey: user.walletPrivateKey,
      method: "approveDeliverable",
      args: [project.onChainProjectId],
    });
  }

  const actorKey = user.walletPrivateKey || null;
  const result = await escrowService.releaseMilestone({ milestone, actorKey, project });
  await notifyProject.milestoneCompleted(milestone.sellerId._id || milestone.sellerId, project._id, milestone._id);
  return result;
};

/**
 * Buyer requests changes on the delivered work; the review window extends and
 * the milestone returns to the seller for fixes.
 */
const requestRevision = async ({ milestoneId, user, reason, extraDays }) => {
  assertRole(user, "buyer", "Only the client can request revisions");
  const milestone = await getMilestoneById({ milestoneId });
  assertMilestoneAccess({ milestone, user, roles: ["buyer"] });
  const project = await Project.findById(milestone.projectId._id || milestone.projectId);
  if (milestone.status !== "submitted") {
    throw new AppError("Milestone has no pending submission to review", 409, "INVALID_STATE");
  }
  const days = Math.max(1, Math.floor(Number(extraDays) || 3));

  if (project?.onChainProjectId && user.walletPrivateKey) {
    await chainService.relayCallAs({
      actorKey: user.walletPrivateKey,
      method: "requestChanges",
      args: [project.onChainProjectId, days],
    });
  }

  milestone.status = "revision_requested";
  milestone.revisionsUsed = (milestone.revisionsUsed || 0) + 1;
  milestone.revisionRequests = milestone.revisionRequests || [];
  milestone.revisionRequests.push({ reason: reason || "Changes requested", requestedAt: new Date(), resolved: false });
  await milestone.save();

  await notifyProject.revisionRequested(milestone.sellerId._id || milestone.sellerId, project._id, milestone._id);
  return { milestone: milestoneFromDoc(milestone) };
};

module.exports = {
  createMilestone,
  listForProject,
  listMine,
  getMilestoneById,
  submitMilestone,
  resubmitMilestone,
  approveMilestone,
  requestRevision,
  getPreferredAmount,
};