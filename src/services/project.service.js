const mongoose = require("mongoose");
const Project = require("../models/Project");
const Proposal = require("../models/Proposal");
const Milestone = require("../models/Milestone");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const chainService = require("./chain.service");
const walletActor = require("./walletActor.service");
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

const PROJECT_TYPES = ["fixed", "hourly"];
const ON_CHAIN_TYPES = ["fixclaim", "milestones"];

/**
 * The on-chain contract variant ("fixclaim" vs "milestones") is chosen by the
 * client explicitly; otherwise fall back to deriving it from the pricing type.
 */
const resolveOnChainType = (body, projectType) =>
  ON_CHAIN_TYPES.includes(body?.onChainProjectType)
    ? body.onChainProjectType
    : onChainTypeName(projectType);

const projectCreateableFields = (body) => ({
  title: body.title,
  description: body.description,
  category: body.category,
  subcategory: body.subcategory || null,
  skills: Array.isArray(body.skills) ? body.skills : [],
  experienceLevel: body.experienceLevel || "intermediate",
  // Clients may send the on-chain label ("milestones"/"fixclaim") by mistake;
  // normalize to a valid model value instead of failing validation.
  projectType: PROJECT_TYPES.includes(body.projectType) ? body.projectType : "fixed",
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

/**
 * Escrow and on-chain state are only visible to the project's client, its hired
 * freelancer, and admins. `getOwnedProject` intentionally performs NO
 * authorization (public project pages rely on it), so every escrow / contract
 * endpoint must call this explicitly before touching funds.
 */
const assertProjectParticipant = async ({ projectId, user }) => {
  const project = await getOwnedProject({ projectId, user });
  if (user?.role === "admin") return project;
  const uid = String(user?._id || "");
  const isClient = String(project.buyerId?._id || project.buyerId) === uid;
  const isFreelancer =
    String(project.hiredSellerId?._id || project.hiredSellerId || "") === uid;
  if (!isClient && !isFreelancer) {
    throw new AppError("You are not a participant in this project", 403, "FORBIDDEN");
  }
  return project;
};

const assertBuyerOwner = (project, user) => {
  if (String(project.buyerId?._id || project.buyerId) !== String(user._id) && user.role !== "admin") {
    throw new AppError("Only the client who created this project can do that", 403, "FORBIDDEN");
  }
};

/**
 * Resolves the key used to relay the on-chain createProject call.
 *
 * `createProject` / `approveProject` are `onlyClient` on-chain: msg.sender BECOMES
 * `project.client`. There is no way for a third party to create a project on a
 * buyer's behalf, so there must be NO admin fallback here - doing so would record
 * the admin as the on-chain client while MongoDB records the buyer, and the buyer
 * could then never fund, approve or refund their own project. Use the buyer's own
 * key, and prove it controls the right wallet before signing.
 *
 * Which of the buyer's keys is correct depends on the project:
 *   - already published -> whichever one controls its recorded on-chain client
 *   - not yet published -> their preferred wallet (`walletMode`)
 * `resolveActorKey` reads the chain to decide; see walletActor.service.js.
 */
const resolveProjectRelayKey = async (user, project = null) => {
  if (!user?.walletPrivateKey && !user?.externalWallet?.privateKey) return null;

  const resolved = await walletActor.resolveActorKey({
    user,
    project,
    party: "client",
    label: "You",
  });

  if (!resolved.actorKey) return null;

  // Belt-and-braces: never sign as a wallet the key does not control.
  chainService.assertKeyControlsAddress(resolved.actorKey, resolved.actorAddress, "You");
  return resolved.actorKey;
};

/**
 * Pushes a project on-chain via the backend relayer and opens it for proposals.
 * Shared by createProject (post-now) and publishProject (draft -> post later).
 * @returns {{ txHash?: string, onChainProjectId?: number, onChainError?: string|null, walletRequired: boolean }}
 */
const pushProjectOnChain = async ({ project, user }) => {
  if (project.onChainProjectId) {
    return { onChainProjectId: project.onChainProjectId, onChainError: null, walletRequired: false };
  }
  const relayKey = await resolveProjectRelayKey(user, project);
  if (!relayKey) {
    return { onChainError: null, walletRequired: true };
  }
  try {
    await chainService.assertChainAvailable();
    const { txHash, receipt } = await chainService.relayCallAs({
      actorKey: relayKey,
      method: "createProject",
      args: [onChainTypeFor(), project.projectNumber],
      context: {
        userId: user?._id || user?.id || null,
        projectId: project._id,
        description: `Published project ${project.projectNumber} on-chain`,
      },
    });
    const created = chainService.parseEventFromReceipt(receipt, "ProjectCreated");
    const onChainProjectId = created
      ? Number(created.args.projectId)
      : await chainService.getProjectCounter();
    return { onChainProjectId, txHash, onChainError: null, walletRequired: false };
  } catch (error) {
    if (error instanceof AppError) throw error;
    return { onChainError: error.message, walletRequired: false };
  }
};

/** Notifies matching freelancers that a project is now open for proposals. */
const notifyFreelancersOfProject = async (project) => {
  try {
    const buyer = await User.findById(project.buyerId)
      .select("firstName lastName username")
      .lean();
    const buyerName =
      [buyer?.firstName, buyer?.lastName].filter(Boolean).join(" ").trim() || buyer?.username || "A client";
    await notifyProject.projectPosted(project, {
      skills: Array.isArray(project.skills) ? project.skills : [],
      buyerName,
    });
  } catch (error) {
    console.error("Project fan-out notification failed (non-fatal):", error.message);
  }
};

const assertRole = (user, role, message = "Not authorized") => {
  if (user.role !== role && user.role !== "admin") {
    throw new AppError(message, 403, "FORBIDDEN");
  }
};

/**
 * Creates a project.
 *
 * `body.saveAsDraft === true` keeps it as a draft (client can post it later via
 * publishProject). Otherwise the project is pushed on-chain immediately and
 * opened for proposals so freelancers are notified. When the buyer has no stored
 * wallet key the project stays a draft with `walletRequired` and the frontend
 * completes the on-chain step via /projects/:id/onchain.
 */
const createProject = async ({ user, body }) => {
  const data = projectCreateableFields(body);
  const saveAsDraft = body.saveAsDraft === true || body.status === "draft";
  const project = new Project({
    projectNumber: await Project.generateProjectNumber(),
    buyerId: user._id,
    ...data,
    onChainProjectType: resolveOnChainType(body, data.projectType),
    status: "draft",
  });

  let walletRequired = false;
  let onChainError = null;
  let createTxHash = null;

  if (!saveAsDraft) {
    const result = await pushProjectOnChain({ project, user });
    walletRequired = result.walletRequired;
    onChainError = result.onChainError || null;
    if (result.onChainProjectId) {
      project.onChainProjectId = result.onChainProjectId;
      createTxHash = result.txHash || null;
      project.metadata = createTxHash ? { createTxHash } : project.metadata;
      project.status = "open";
    }
  } else {
    walletRequired = false;
  }

  await project.save();

  if (project.status === "open") {
    await notifyFreelancersOfProject(project);
  }

  return {
    project,
    walletRequired,
    onChainError: onChainError || null,
    createTxHash: createTxHash || project.metadata?.createTxHash || null,
  };
};

/**
 * Publishes a draft project: pushes it on-chain, flips it to `open` so
 * freelancers can see and apply, and notifies matching freelancers.
 */
const publishProject = async ({ user, projectId }) => {
  const project = await getOwnedProject({ projectId, user });
  assertBuyerOwner(project, user);
  if (project.status !== "draft") {
    throw new AppError("Only a draft project can be published", 409, "INVALID_STATE");
  } 
  const result = await pushProjectOnChain({ project, user });
  
  if (result.walletRequired) {
    return { project, walletRequired: true, published: false };
  }
  if (result.onChainError) {
    throw new AppError(
      `Could not publish the project on-chain: ${result.onChainError}`,
      502,
      "CHAIN_ERROR"
    );
  }
  if (result.onChainProjectId) project.onChainProjectId = result.onChainProjectId;
  if (result.txHash) project.metadata = { ...(project.metadata || {}), createTxHash: result.txHash };
  project.status = "open";
  project.publishedAt = new Date();
  await project.save();

  await notifyFreelancersOfProject(project);

  return { project, walletRequired: false, published: true };
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
  project.onChainProjectType = project.onChainProjectType || onChainTypeName(project.projectType);
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
  publishProject,
  confirmOnChainProject,
  listProjects,
  getProject,
  cancelProject,
  getOwnedProject,
  assertProjectParticipant,
  assertRole,
};