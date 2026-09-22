const mongoose = require("mongoose");
const Project = require("../models/Project");
const Proposal = require("../models/Proposal");
const Milestone = require("../models/Milestone");
const AppError = require("../utils/AppError");
const chainService = require("./chain.service");
const { notifyProject } = require("./notification.service");

/**
 * Project lifecycle service (escrow flow).
 *
 * A project is owned by a buyer (client). It is pushed on-chain (Blockefy
 * contract) as either the `fixclaim` type (one-shot work -> a single milestone
 * is auto-created on hiring) or the `milestones` type (multi-milestone plan).
 * Freelancers are only assigned after proposal acceptance
 * (see proposal.service).
 */

const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/**
 * The deployed Blockefy contract models a real FixClaim as a Milestones project
 * with exactly one milestone: the on-chain FixClaim type has no submission path
 * (isSubmitted only flips via completeMilestone, which requires a milestone a
 * FixClaim project can never have), so every project is pushed on-chain as
 * type 1 (Milestones) and the fixclaim/milestones distinction stays a DB label.
 */
const onChainTypeFor = () => 1;
const onChainTypeName = (projectType) => (projectType === "fixed" ? "fixclaim" : "milestones");

const POPULATE_SELLER = {
  path: "hiredSellerId",
  select: "firstName lastName email avatar username sellerProfile.professionalTitle",
};
const POPULATE_BUYER = {
  path: "buyerId",
  select: "firstName lastName email avatar username buyerProfile.company buyerProfile.industry",
};

const projectCreateableFields = (body) => ({
  title: body.title,
  description: body.description,
  category: body.category,
  subcategory: body.subcategory || null,
  skills: Array.isArray(body.skills) ? body.skills : [],
  experienceLevel: body.experienceLevel || "intermediate",
  projectType: body.projectType || "fixed",
  budget: body.budget && body.budget.max
    ? { min: body.budget.min || 0, max: body.budget.max, currency: body.currency || "ETH" }
    : undefined,
  duration: body.duration || null,
  visibility: body.visibility || "public",
  deadline: body.deadline ? new Date(body.deadline) : null,
  attachments: Array.isArray(body.attachments) ? body.attachments : [],
});

const getOwnedProject = async ({ projectId, user }) => {
  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    throw new AppError("Invalid project id", 400, "INVALID_ID");
  }
  const project = await Project.findById(projectId);
  if (!project) throw new AppError("Project not found", 404, "NOT_FOUND");
  return project;
};

const assertRole = (user, role, message = "Not authorized") => {
  if (user.role !== role && user.role !== "admin") {
    throw new AppError(message, 403, "FORBIDDEN");
  }
};

/**
 * Creates a project. When the acting buyer has a stored private key OR a
 * relayer wallet is configured, the project is created on-chain immediately;
 * otherwise the project is saved as a draft with `walletRequired` and the
 * frontend pushes it to the chain via /projects/:id/onchain.
 */
const createProject = async ({ user, body }) => {
  const data = projectCreateableFields(body);
  const project = new Project({
    projectNumber: await Project.generateProjectNumber(),
    buyerId: user._id,
    ...data,
    onChainProjectType: onChainTypeName(data.projectType),
    status: "draft",
  });

  let walletRequired = false;
  let onChainError = null;

  if (user.walletPrivateKey) {
    try {
      await chainService.assertChainAvailable();
      const { txHash, receipt } = await chainService.relayCallAs({
        actorKey: user.walletPrivateKey,
        method: "createProject",
        args: [onChainTypeFor(), project.projectNumber],
      });
      const created = chainService.parseEventFromReceipt(receipt, "ProjectCreated");
      const onChainProjectId = created
        ? Number(created.args.projectId)
        : await chainService.getProjectCounter();
      project.onChainProjectId = onChainProjectId;
      project.status = "open";
      project.metadata = { createTxHash: txHash };
    } catch (error) {
      if (error instanceof AppError) throw error;
      onChainError = error.message;
    }
  } else {
    walletRequired = true;
  }

  await project.save();

  return {
    project,
    walletRequired,
    onChainError: onChainError || null,
    createTxHash: project.metadata?.createTxHash || null,
  };
};

/**
 * Records an on-chain project after the buyer signed createProject in their
 * wallet (used when the backend could not relay it).
 */
const confirmOnChainProject = async ({ user, projectId, txHash }) => {
  const project = await getOwnedProject({ projectId, user });
  if (String(project.buyerId) !== String(user._id) && user.role !== "admin") {
    throw new AppError("Not authorized", 403, "FORBIDDEN");
  }
  if (project.onChainProjectId) {
    return { project, alreadyOnChain: true };
  }
  const receipt = await chainService.getProvider().getTransactionReceipt(txHash);
  if (!receipt || Number(receipt.status) !== 1) {
    throw new AppError("Transaction not found or failed", 422, "TX_FAILED");
  }
  const event = chainService.parseEventFromReceipt(receipt, "ProjectCreated");
  if (!event) {
    throw new AppError("No project creation event in this transaction", 422, "TX_INVALID");
  }
  project.onChainProjectId = Number(event.args.projectId);
  project.onChainProjectType = onChainTypeName(project.projectType);
  project.status = "open";
  project.metadata = { createTxHash: txHash };
  await project.save();
  return { project, alreadyOnChain: false };
};

const listProjects = async ({ user, role, status, page = 1, limit = 20 }) => {
  // Pagination setup
  const pg = Math.max(1, Number(page) || 1);
  const lm = Math.min(50, Math.max(1, Number(limit) || 20));

  // Build filter based on role
  const filter = {};
  if (role === "seller") {
    filter.hiredSellerId = user._id;
  } else if (role === "buyer") {
    filter.buyerId = user._id;
  } else if (role === "public") {
    // Discovery browse: only open, public projects
    filter.status = "open";
    filter.visibility = "public";
  } else if (user.role === "admin" && role !== "admin") {
    throw new AppError("Invalid role filter", 400, "INVALID_ROLE");
  }

  // Apply status filter only if not public (public is fixed to 'open')
  if (status && role !== "public") {
    filter.status = status;
  }

  // Fetch projects and total count in parallel
  const [docs, total] = await Promise.all([
    Project.find(filter)
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lm)
      .limit(lm)
      .populate(POPULATE_SELLER)
      .populate(POPULATE_BUYER)
      .populate("selectedProposalId", "bidAmount bidCurrency")
      .lean(),
    Project.countDocuments(filter),
  ]);

  const projectIds = docs.map((d) => d._id);

  // Fetch escrow totals and accepted bids for these projects (if any)
  const [escrowTotals, acceptedBids] = projectIds.length
    ? await Promise.all([
        Milestone.aggregate([
          { $match: { projectId: { $in: projectIds } } },
          { $group: { _id: "$projectId", total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        Proposal.aggregate([
          { $match: { projectId: { $in: projectIds }, status: "accepted" } },
          { $sort: { updatedAt: -1 } },
          { $group: { _id: "$projectId", bidAmount: { $first: "$bidAmount" } } },
        ]),
      ])
    : [[], []];

  // Create maps for quick lookup
  const escrowByProject = new Map(escrowTotals.map((e) => [String(e._id), e]));
  const bidByProject = new Map(acceptedBids.map((p) => [String(p._id), p]));

  // Enrich projects with escrow and accepted bid data
  docs.forEach((d) => {
    const projectIdStr = String(d._id);
    const esc = escrowByProject.get(projectIdStr);
    d.escrowTotalEth = esc ? round4(esc.total) : 0;
    d.milestoneCount = esc ? esc.count : 0;
    d.acceptedBidEth =
      (bidByProject.get(projectIdStr)?.bidAmount ?? d.selectedProposalId?.bidAmount) || null;
    delete d.selectedProposalId;
  });

  return {
    projects: docs,
    pagination: {
      page: pg,
      limit: lm,
      total,
      pages: Math.ceil(total / lm),
    },
  };
};
const getProject = async ({ user, projectId }) => {
  const doc = await getOwnedProject({ projectId, user }).then((p) =>
    Project.findById(p._id)
      .populate(POPULATE_SELLER)
      .populate(POPULATE_BUYER)
      .populate("selectedProposalId")
  );
  const project = doc.toObject();
  // buyerId is populated (document) so compare on _id; sellerId likewise.
  const isBuyer = String(project.buyerId?._id || project.buyerId) === String(user._id);
  const isSeller = project.hiredSellerId && String(project.hiredSellerId._id || project.hiredSellerId) === String(user._id);
  const isAdmin = user.role === "admin";
  const isPublicBrief = project.status === "open" && project.visibility === "public";
  if (!isBuyer && !isSeller && !isAdmin && !isPublicBrief) {
    const proposed = await Proposal.exists({ projectId: project._id, sellerId: user._id });
    if (!proposed) throw new AppError("Not authorized", 403, "FORBIDDEN");
  }

  const escrow = await Milestone.aggregate([
    { $match: { projectId: project._id } },
    { $group: { _id: "$projectId", total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  project.escrowTotalEth = escrow[0] ? round4(escrow[0].total) : 0;
  project.milestoneCount = escrow[0]?.count || 0;
  project.acceptedBidEth = project.selectedProposalId?.bidAmount ?? null;

  return { project };
};

const cancelProject = async ({ user, projectId, reason }) => {
  const project = await getOwnedProject({ projectId, user });
  assertRole(user, "buyer", "Only the client can cancel a project");
  if (String(project.buyerId) !== String(user._id) && user.role !== "admin") {
    throw new AppError("Not authorized", 403, "FORBIDDEN");
  }
  if (!["open", "draft"].includes(project.status)) {
    throw new AppError(
      "Only projects without funds in escrow can be cancelled directly. Use the refund flow for funded projects.",
      409,
      "INVALID_STATE"
    );
  }
  project.status = "cancelled";
  project.cancelReason = reason || "Cancelled by client";
  project.cancelledAt = new Date();
  await project.save();
  return { project };
};

module.exports = {
  createProject,
  confirmOnChainProject,
  listProjects,
  getProject,
  cancelProject,
  getOwnedProject,
  assertRole,
};