const mongoose = require("mongoose");
const Milestone = require("../models/Milestone");
const Project = require("../models/Project");
const AppError = require("../utils/AppError");
const chainService = require("./chain.service");
const escrowService = require("./escrow.service");
const walletActor = require("./walletActor.service");
const { notifyProject } = require("./notification.service");
const { getOwnedProject, assertRole } = require("./project.service");

/**
 * Milestone service (on-chain escrow).
 *
 * Milestones can be added at any point in the project lifecycle, including
 * after funding and after earlier milestones were released. Adding one to a
 * completed project re-opens it, so the client and freelancer can always extend
 * the work with another phase.
 */

/** Must stay <= Blockefy.MAX_DESCRIPTION_LENGTH (500 bytes) or the relay reverts. */
const MAX_ONCHAIN_DESCRIPTION = 500;

/** Mirrors the `title` column cap so the DB row and the chain row cannot disagree. */
const MAX_TITLE_LENGTH = 200;

/**
 * Truncates on a UTF-8 byte boundary, never mid-codepoint, so a non-ASCII title
 * cannot become invalid UTF-8 (which Solidity would reject on decode).
 */
const truncateToBytes = (value, maxBytes) => {
  const str = String(value);
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  const buf = Buffer.from(str, "utf8").subarray(0, maxBytes);
  // Back off until the last codepoint is complete (it would end with 0x80-0xBF).
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (buf[end - 1] & 0x80) !== 0) end -= 1;
  return buf.subarray(0, end).toString("utf8");
};

// Invariant: the title we send on-chain is truncated to MAX_TITLE_LENGTH *bytes*,
// so it can only violate the contract's cap if these two drift apart. Fail loudly
// at load rather than reverting every milestone on-chain.
if (MAX_TITLE_LENGTH > MAX_ONCHAIN_DESCRIPTION) {
  throw new Error(
    `Milestone title cap (${MAX_TITLE_LENGTH} bytes) exceeds the contract limit (${MAX_ONCHAIN_DESCRIPTION} bytes)`
  );
}

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

/**
 * Freelancer creates a milestone (on-chain + Mongo).
 *
 * Milestones may be added at ANY point in the lifecycle - before funding,
 * during work, or to add a new phase after an earlier one was released (which
 * re-opens a completed project). The contract enforces this; an earlier version
 * locked milestones once funding started, which made a completed project
 * impossible to extend.
 */
const createMilestone = async ({ user, projectId, body }) => {
  assertRole(user, "seller", "Only the assigned freelancer can create milestones");
  const project = await getOwnedProject({ projectId, user });
  if (String(project.hiredSellerId || "") !== String(user._id) && user.role !== "admin") {
    throw new AppError("You are not the assigned freelancer on this project", 403, "FORBIDDEN");
  }
  // Milestones may be added to an in-progress project, or to a COMPLETED one to
  // re-open it with a new phase. Cancelled / disputed / not-yet-started projects
  // are not extendable.
  if (!["in_progress", "completed"].includes(project.status)) {
    throw new AppError(
      "Milestones can only be added while the project is in progress (a completed project is re-opened)",
      409,
      "INVALID_STATE"
    );
  }
  const amount = Number(body.amount);
  if (!amount || amount <= 0) {
    throw new AppError("Milestone amount must be greater than 0", 400, "VALIDATION");
  }

  // The contract caps the description by BYTE length, while String.slice counts
  // UTF-16 code units - so trim to the cap on a byte boundary, otherwise a title
  // with emoji/accents would exceed the cap (or become invalid UTF-8) and revert.
  // The same string is stored in Mongo and sent to the contract, so they cannot
  // disagree.
  const title = truncateToBytes(String(body.title || "Milestone"), MAX_TITLE_LENGTH);

  let onChainMilestoneId = null;
  if (project.onChainProjectId) {
    if (!user.walletPrivateKey && !user.externalWallet?.privateKey) {
      // `createMilestone` is `onlyFreelancer` on-chain, so there is no fallback
      // actor. Creating the DB row without the chain row would leave a milestone
      // the contract has never heard of.
      throw new AppError(
        "No wallet key available to create the milestone on-chain. Link a wallet to your account first.",
        422,
        "NO_RELAY"
      );
    }
    const { actorKey } = await walletActor.requireActorKey({
      user,
      project,
      party: "freelancer",
      label: "You",
    });
    const { receipt } = await chainService.relayCallAs({
      actorKey,
      method: "createMilestone",
      args: [project.onChainProjectId, title, chainService.toWei(amount)],
      context: {
        userId: user._id,
        projectId: project._id,
        description: `Created milestone "${title}"`,
      },
    });
    const created = chainService.parseEventFromReceipt(receipt, "MilestoneCreated");
    onChainMilestoneId = created ? Number(created.args.milestoneId) : await chainService.getMilestoneCounter();
  }

  const milestone = new Milestone({
    milestoneNumber: await Milestone.generateMilestoneNumber(),
    projectId: project._id,
    buyerId: project.buyerId,
    sellerId: user._id,
    title,
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

  if (project.onChainProjectId && milestone.onChainMilestoneId) {
    const submitKey = await walletActor.resolveActorKey({
      user,
      project,
      party: "freelancer",
      label: "You",
    });
    if (submitKey.actorKey) {
      await chainService.relayCallAs({
        actorKey: submitKey.actorKey,
        method: "completeMilestone",
        args: [project.onChainProjectId, milestone.onChainMilestoneId],
        context: {
          userId: user._id,
          projectId: project._id,
          milestoneId: milestone._id,
          description: "Submitted milestone for review",
        },
      });
    }
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
 * Freelancer re-submits after a revision request.
 *
 * This MUST relay on-chain: `requestChanges` clears `isCompleted` on the
 * contract (that is what re-opens the milestone), and `approveDeliverable`
 * requires `isCompleted` to be true. Re-submitting only in Mongo therefore
 * leaves the milestone permanently un-approvable, so the buyer could never
 * release it and the rework path would deadlock.
 */
const resubmitMilestone = async ({ milestoneId, user, data }) => {
  assertRole(user, "seller", "Only the freelancer can resubmit work");
  const milestone = await getMilestoneById({ milestoneId });
  assertMilestoneAccess({ milestone, user, roles: ["seller"] });
  if (milestone.status !== "revision_requested") {
    throw new AppError("Milestone is not under revision", 409, "INVALID_STATE");
  }
  const project = await Project.findById(milestone.projectId._id || milestone.projectId);
  if (!project?.onChainProjectId) {
    throw new AppError("Project has no on-chain escrow", 409, "NO_ONCHAIN");
  }
  if (String(project.hiredSellerId || "") !== String(milestone.sellerId?._id || milestone.sellerId)) {
    throw new AppError("You are not the assigned freelancer", 403, "FORBIDDEN");
  }

  if (project.onChainProjectId && milestone.onChainMilestoneId) {
    if (!user.walletPrivateKey && !user.externalWallet?.privateKey) {
      // `completeMilestone` is `onlyFreelancer` on-chain. Without the seller's
      // key the contract stays in the re-opened state and `approveDeliverable`
      // would revert forever, so the DB must not move ahead of the chain.
      throw new AppError(
        "No wallet key available to re-submit on-chain. Link a wallet to your account first.",
        422,
        "NO_RELAY"
      );
    }
    const { actorKey: resubmitKey } = await walletActor.requireActorKey({
      user,
      project,
      party: "freelancer",
      label: "You",
    });
    await chainService.relayCallAs({
      actorKey: resubmitKey,
      method: "completeMilestone",
      args: [project.onChainProjectId, milestone.onChainMilestoneId],
      context: {
        userId: user._id,
        projectId: project._id,
        milestoneId: milestone._id,
        description: "Resubmitted milestone after revision",
      },
    });
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

  const { actorKey: approvalKey } = await walletActor.requireActorKey({
    user,
    project,
    party: "client",
    label: "You",
  });

  await chainService.relayCallAs({
    actorKey: approvalKey,
    method: "approveDeliverable",
    args: [project.onChainProjectId, milestone.onChainMilestoneId],
    context: {
      userId: user._id,
      projectId: project._id,
      milestoneId: milestone._id,
      description: "Approved deliverable and released payment",
    },
  });

  const result = await escrowService.releaseMilestone({
    milestone,
    actorKey: approvalKey,
    project,
  });
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

  if (project?.onChainProjectId) {
    if (!milestone.onChainMilestoneId) {
      throw new AppError("Milestone has no on-chain reference", 409, "NO_ONCHAIN");
    }
    // `requestChanges` is `onlyClient` on-chain: without the buyer's key the
    // contract would keep the milestone in the submitted state and block the
    // freelancer from re-submitting, so the DB must not move ahead.
    const { actorKey: revisionKey } = await walletActor.requireActorKey({
      user,
      project,
      party: "client",
      label: "You",
    });
    await chainService.relayCallAs({
      actorKey: revisionKey,
      method: "requestChanges",
      args: [project.onChainProjectId, milestone.onChainMilestoneId, days],
      context: {
        userId: user._id,
        projectId: project._id,
        milestoneId: milestone._id,
        description: reason
          ? `Requested changes: ${String(reason).slice(0, 160)}`
          : "Requested changes to the deliverable",
      },
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