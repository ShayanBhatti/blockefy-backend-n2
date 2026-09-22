const mongoose = require("mongoose");
const Project = require("../models/Project");
const Proposal = require("../models/Proposal");
const Milestone = require("../models/Milestone");
const AppError = require("../utils/AppError");
const chainService = require("./chain.service");
const { notifyProject } = require("./notification.service");
const { getOwnedProject, assertRole } = require("./project.service");

/**
 * Proposal lifecycle service.
 *
 * Freelancers submit proposals (off-chain) with an optional milestone plan.
 * On acceptance the buyer assigns the freelancer on-chain (approveProject) and
 * the contract's freelancer address points to the seller's wallet.
 */

const sanityMilestones = (milestones = []) =>
  (Array.isArray(milestones) ? milestones : [])
    .filter((m) => m && m.title && Number(m.amount) > 0)
    .slice(0, 30)
    .map((m, i) => ({
      title: String(m.title).slice(0, 200),
      description: String(m.description || "").slice(0, 2000),
      amount: Math.round(Number(m.amount) * 100) / 100,
      dueDate: m.dueDate ? new Date(m.dueDate) : null,
      order: i + 1,
    }));

const getProposal = async ({ proposalId }) => {
  if (!mongoose.Types.ObjectId.isValid(proposalId)) {
    throw new AppError("Invalid proposal id", 400, "INVALID_ID");
  }
  const proposal = await Proposal.findById(proposalId)
    .populate("projectId", "title projectNumber status buyerId hiredSellerId")
    .populate("sellerId", "firstName lastName email avatar username sellerProfile.professionalTitle");
  if (!proposal) throw new AppError("Proposal not found", 404, "NOT_FOUND");
  return proposal;
};

const assertProposalAccess = ({ user, proposal }) => {
  if (user.role === "admin") return;
  const isSeller = String(proposal.sellerId?._id || proposal.sellerId) === String(user._id);
  const isBuyer = String(proposal.buyerId) === String(user._id);
  if (!isSeller && !isBuyer) throw new AppError("Not authorized", 403, "FORBIDDEN");
};

const canEditProposal = (proposal) =>
  ["submitted", "pending", "viewed", "shortlisted", "revision_requested"].includes(proposal.status);

/**
 * Freelancer submits a proposal for an open project. One active proposal per
 * seller per project.
 */
const createProposal = async ({ user, projectId, body }) => {
  assertRole(user, "seller", "Only freelancers can submit proposals");
  const project = await getOwnedProject({ projectId, user });
  if (String(project.buyerId) === String(user._id)) {
    throw new AppError("You cannot propose on your own project", 400, "SELF_PROPOSAL");
  }
  if (project.status !== "open") {
    throw new AppError("Project is not open for proposals", 409, "INVALID_STATE");
  }
  const existing = await Proposal.findOne({
    projectId: project._id,
    sellerId: user._id,
    status: { $nin: ["withdrawn", "rejected", "expired"] },
  });
  if (existing) {
    throw new AppError("You already have an active proposal on this project", 409, "DUPLICATE_PROPOSAL");
  }
  if (!body.coverLetter || !Number(body.bidAmount) || !body.estimatedDuration) {
    throw new AppError("coverLetter, bidAmount and estimatedDuration are required", 400, "VALIDATION");
  }

  const proposal = new Proposal({
    proposalNumber: await Proposal.generateProposalNumber(),
    projectId: project._id,
    sellerId: user._id,
    buyerId: project.buyerId,
    coverLetter: String(body.coverLetter).slice(0, 5000),
    bidAmount: Math.round(Number(body.bidAmount) * 100) / 100,
    estimatedDuration: String(body.estimatedDuration),
    deliveryDays: Number(body.deliveryDays) || 1,
    milestones: sanityMilestones(body.milestones),
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    gigId: body.gigId || null,
    termsAccepted: Boolean(body.termsAccepted),
    termsAcceptedAt: body.termsAccepted ? new Date() : null,
  });
  await proposal.save();

  project.proposalCount = (project.proposalCount || 0) + 1;
  await project.save();

  const sellerName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "A freelancer";
  await notifyProject.proposalReceived(project.buyerId, project._id, sellerName);

  return { proposal };
};

const listForProject = async ({ projectId, user }) => {
  const project = await getOwnedProject({ projectId, user });
  const isBuyer = String(project.buyerId?._id || project.buyerId) === String(user._id);
  const isSeller = String(project.hiredSellerId?._id || project.hiredSellerId || "") === String(user._id);
  const isAdmin = user.role === "admin";
  if (!isBuyer && !isSeller && !isAdmin) throw new AppError("Not authorized", 403, "FORBIDDEN");
  const proposals = await Proposal.find({ projectId: project._id })
    .sort({ createdAt: -1 })
    .populate("sellerId", "firstName lastName email avatar username rating sellerProfile.professionalTitle");
  return { proposals };
};

const listMine = async ({ user, role, status }) => {
  const filter = {};
  if (user.role === "admin" && role === "admin") {
    // admins can browse all proposals
  } else if (role === "seller") {
    filter.sellerId = user._id;
  } else if (role === "buyer") {
    filter.buyerId = user._id;
  } else {
    filter.$or = [{ sellerId: user._id }, { buyerId: user._id }];
  }
  if (status) filter.status = status;
  const proposals = await Proposal.find(filter)
    .sort({ createdAt: -1 })
    .populate("projectId", "title projectNumber status budget currency")
    .populate("sellerId", "firstName lastName email avatar username");
  return { proposals };
};

const getProposalDetail = async ({ user, proposalId }) => {
  const proposal = await getProposal({ proposalId });
  assertProposalAccess({ user, proposal });
  if (String(proposal.buyerId) === String(user._id) && !proposal.viewedAt) {
    proposal.viewedAt = new Date();
    await proposal.save();
  }
  return { proposal };
};

/**
 * Buyer accepts the proposal: assigns the freelancer on-chain and locks the
 * project in progress. Other pending proposals are rejected.
 */
const acceptProposal = async ({ user, proposalId }) => {
  assertRole(user, "buyer", "Only the client can accept a proposal");
  const proposal = await getProposal({ proposalId });
  if (String(proposal.buyerId) !== String(user._id) && user.role !== "admin") {
    throw new AppError("Not authorized", 403, "FORBIDDEN");
  }
  const project = await Project.findById(proposal.projectId._id || proposal.projectId);
  if (!project) throw new AppError("Project not found", 404, "NOT_FOUND");
  if (project.status !== "open") {
    throw new AppError("Project is not open for hiring", 409, "INVALID_STATE");
  }
  if (![proposal.status].every((s) => ["submitted", "pending", "viewed", "shortlisted"].includes(s))) {
    throw new AppError("Proposal is not in an acceptable state", 409, "INVALID_STATE");
  }

  const seller = await mongoose.model("User").findById(proposal.sellerId._id || proposal.sellerId);
  if (!seller?.walletAddress && !seller?.walletPrivateKey) {
    throw new AppError("The freelancer has no connected wallet", 422, "NO_WALLET");
  }
  const freelancerAddress = seller.walletAddress || seller.authProviders?.wallet?.walletAddress;

  let txHash = null;
  if (project.onChainProjectId && user.walletPrivateKey) {
    if (!freelancerAddress) {
      throw new AppError("Freelancer wallet address is required", 422, "NO_WALLET");
    }
    const { txHash: hash } = await chainService.relayCallAs({
      actorKey: user.walletPrivateKey,
      method: "approveProject",
      args: [project.onChainProjectId, freelancerAddress],
    });
    txHash = hash;
  } else if (project.onChainProjectId) {
    throw new AppError(
      "Your wallet is not connected to the backend. Complete project creation first.",
      422,
      "WALLET_REQUIRED"
    );
  }

  proposal.status = "accepted";
  proposal.acceptedAt = new Date();
  await proposal.save();

  project.selectedProposalId = proposal._id;
  project.hiredSellerId = proposal.sellerId._id || proposal.sellerId;
  project.hiredAt = new Date();
  project.status = "in_progress";
  if (txHash) project.metadata = { ...(project.metadata || {}), approveTxHash: txHash };
  await project.save();

  // FixClaim projects: auto-create the single "Deliverable" milestone on-chain
  // so the client can deposit right away (contract requires the milestone to
  // exist before the first deposit flips the project to InProgress).
  let fixClaimMilestone = null;
  if (project.onChainProjectType === "fixclaim" && project.onChainProjectId && seller.walletPrivateKey) {
    const existing = await Milestone.exists({
      projectId: project._id,
      sellerId: seller._id,
      deliveryType: "project",
    });
    if (!existing) {
      const { receipt } = await chainService.relayCallAs({
        actorKey: seller.walletPrivateKey,
        method: "createMilestone",
        args: [
          project.onChainProjectId,
          "Deliverable",
          chainService.toWei(proposal.bidAmount),
        ],
      });
      const created = chainService.parseEventFromReceipt(receipt, "MilestoneCreated");
      const onChainMilestoneId = created
        ? Number(created.args.milestoneId)
        : await chainService.getMilestoneCounter();

      fixClaimMilestone = await Milestone.create({
        milestoneNumber: await Milestone.generateMilestoneNumber(),
        projectId: project._id,
        buyerId: project.buyerId,
        sellerId: seller._id,
        title: "Deliverable",
        description: String(proposal.coverLetter || "").slice(0, 2000),
        amount: Math.round(Number(proposal.bidAmount) * 100) / 100,
        currency: "ETH",
        dueDate: new Date(Date.now() + (Number(proposal.deliveryDays) || 7) * 86400000),
        onChainMilestoneId,
        status: "pending",
        deliveryType: "project",
      });
    }
  }

  await Proposal.updateMany(
    { projectId: project._id, _id: { $ne: proposal._id }, status: { $in: ["submitted", "pending", "viewed", "shortlisted"] } },
    { $set: { status: "rejected", rejectionReason: "Another proposal was accepted" } }
  );

  await notifyProject.proposalAccepted(proposal.sellerId._id || proposal.sellerId, project._id);

  return { proposal: await getProposal({ proposalId }), project, fixClaimMilestone };
};

const rejectProposal = async ({ user, proposalId, reason }) => {
  assertRole(user, "buyer", "Only the client can reject a proposal");
  const proposal = await getProposal({ proposalId });
  if (String(proposal.buyerId) !== String(user._id) && user.role !== "admin") {
    throw new AppError("Not authorized", 403, "FORBIDDEN");
  }
  if (!["submitted", "pending", "viewed", "shortlisted", "revision_requested"].includes(proposal.status)) {
    throw new AppError("Proposal is not in a reviewable state", 409, "INVALID_STATE");
  }
  proposal.status = "rejected";
  proposal.rejectionReason = reason || "Declined by client";
  await proposal.save();
  await notifyProject.proposalRejected(proposal.sellerId._id || proposal.sellerId, proposal.projectId?._id || proposal.projectId);
  return { proposal: await getProposal({ proposalId }) };
};

/**
 * Buyer requests changes to a proposal (sends it back to the seller) by also
 * rejecting it. The seller can then edit and resubmit.
 */
const requestRevision = async ({ user, proposalId, reason }) => {
  assertRole(user, "buyer", "Only the client can request proposal revisions");
  const proposal = await getProposal({ proposalId });
  if (String(proposal.buyerId) !== String(user._id) && user.role !== "admin") {
    throw new AppError("Not authorized", 403, "FORBIDDEN");
  }
  proposal.status = "revision_requested";
  proposal.revisionReason = reason || "Please revise your proposal";
  await proposal.save();
  await notifyProject.proposalRejected(proposal.sellerId._id || proposal.sellerId, proposal.projectId?._id || proposal.projectId);
  return { proposal: await getProposal({ proposalId }) };
};

/** Seller withdraws an active proposal. */
const withdrawProposal = async ({ user, proposalId }) => {
  assertRole(user, "seller", "Only the freelancer can withdraw a proposal");
  const proposal = await getProposal({ proposalId });
  if (String(proposal.sellerId?._id || proposal.sellerId) !== String(user._id) && user.role !== "admin") {
    throw new AppError("Not authorized", 403, "FORBIDDEN");
  }
  if (!["submitted", "pending", "viewed", "shortlisted", "revision_requested"].includes(proposal.status)) {
    throw new AppError("Proposal cannot be withdrawn in its current state", 409, "INVALID_STATE");
  }
  proposal.status = "withdrawn";
  await proposal.save();
  return { proposal: await getProposal({ proposalId }) };
};

/** Seller edits + resubmits (after revision request or while pending). */
const updateProposal = async ({ user, proposalId, body }) => {
  assertRole(user, "seller", "Only the freelancer can edit a proposal");
  const proposal = await getProposal({ proposalId });
  if (String(proposal.sellerId?._id || proposal.sellerId) !== String(user._id) && user.role !== "admin") {
    throw new AppError("Not authorized", 403, "FORBIDDEN");
  }
  if (!canEditProposal(proposal)) {
    throw new AppError("Proposal cannot be edited in its current state", 409, "INVALID_STATE");
  }
  if (body.coverLetter !== undefined) proposal.coverLetter = String(body.coverLetter).slice(0, 5000);
  if (body.bidAmount !== undefined) proposal.bidAmount = Math.round(Number(body.bidAmount) * 100) / 100;
  if (body.estimatedDuration !== undefined) proposal.estimatedDuration = String(body.estimatedDuration);
  if (body.deliveryDays !== undefined) proposal.deliveryDays = Number(body.deliveryDays) || proposal.deliveryDays;
  if (body.milestones !== undefined) proposal.milestones = sanityMilestones(body.milestones);
  if (body.attachments !== undefined) proposal.attachments = body.attachments;
  proposal.status = "submitted";
  proposal.revisionReason = null;
  await proposal.save();
  return { proposal: await getProposal({ proposalId }) };
};

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
  getProposal,
  sanityMilestones,
};