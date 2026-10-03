/**
 * Background jobs for the projects / escrow system.
 *
 * Run from src/jobs/index.js on the in-process scheduler. `flagLapsedReviews`
 * and `flagStaleProjects` are read-only + best-effort: they never change
 * project/milestone state, only remind people. `autoReleaseLapsedMilestones`
 * does move money, and is gated behind AUTO_RELEASE_ESCROW=true.
 *
 * Chains that are down or projects without on-chain escrow are skipped
 * silently.
 */

const Project = require("../models/Project");
const Milestone = require("../models/Milestone");
const Notification = require("../models/Notification");
const chainService = require("../services/chain.service");
const escrowService = require("../services/escrow.service");
const notificationService = require("../services/notification.service");

const LAPSED_REVIEW_TYPE = "review_window_lapsed";
const STALE_PROJECT_TYPE = "project_stale";
const AUTO_RELEASED_TYPE = "escrow_auto_released";

/** Skip reminding a project again if a notification of `type` already exists. */
const alreadyNotified = async (userId, projectId, type) => {
  const existing = await Notification.exists({
    userId,
    type,
    "relatedEntity.type": "project",
    "relatedEntity.id": String(projectId),
  });
  return Boolean(existing);
};

/**
 * When a delivery has been submitted but the contract review window has
 * lapsed (`isReviewLapsed`), remind the client to approve or request changes
 * and tell the freelancer to nudge their client. Idempotent per project.
 */
const flagLapsedReviews = async () => {
  const projects = await Project.find({
    status: "in_progress",
    onChainProjectId: { $exists: true, $ne: null },
  })
    .select("_id buyerId hiredSellerId onChainProjectId")
    .lean();

  let flagged = 0;
  for (const project of projects) {
    if (!project.buyerId || !project.hiredSellerId) continue;
    const hasPendingReview = await Milestone.exists({
      projectId: project._id,
      status: "submitted",
    });
    if (!hasPendingReview) continue;

    let lapsed = false;
    try {
      lapsed = await chainService.isReviewLapsed(project.onChainProjectId);
    } catch (error) {
      console.error(`[job] lapsed-review check failed for ${project._id}:`, error.message);
      continue;
    }
    if (!lapsed) continue;

    const buyerId = String(project.buyerId._id || project.buyerId);
    const sellerId = String(project.hiredSellerId._id || project.hiredSellerId);

    if (!(await alreadyNotified(buyerId, project._id, LAPSED_REVIEW_TYPE))) {
      await notificationService.createNotification({
        userId: buyerId,
        type: LAPSED_REVIEW_TYPE,
        title: "Review window lapsed",
        message:
          "The review window for the submitted delivery has passed. Approve it to release escrow, or request changes.",
        priority: "high",
        actionUrl: notificationService.projectActionUrl(project._id),
        relatedEntity: { type: "project", id: project._id },
      });
      if (!(await alreadyNotified(sellerId, project._id, LAPSED_REVIEW_TYPE))) {
        await notificationService.createNotification({
          userId: sellerId,
          type: LAPSED_REVIEW_TYPE,
          title: "Delivery awaiting review",
          message: "Your delivery's review window has lapsed. Ask your client to approve or request changes.",
          priority: "high",
          actionUrl: notificationService.projectActionUrl(project._id),
          relatedEntity: { type: "project", id: project._id },
        });
      }
      flagged += 1;
    }
  }

  return { flagged };
};

/**
 * Open projects that sit with zero proposals grow stale. Remind the buyer
 * (once) to review the brief or share it with freelancers.
 */
const flagStaleProjects = async ({ olderThanDays = Number(process.env.STALE_PROJECT_DAYS || 5) } = {}) => {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const projects = await Project.find({
    status: "open",
    visibility: "public",
    createdAt: { $lte: cutoff },
  })
    .select("_id buyerId title proposalCount createdAt")
    .lean();

  let flagged = 0;
  for (const project of projects) {
    if (!project.buyerId) continue;
    if ((project.proposalCount || 0) > 0) continue;
    const buyerId = String(project.buyerId._id || project.buyerId);
    if (await alreadyNotified(buyerId, project._id, STALE_PROJECT_TYPE)) continue;

    await notificationService.createNotification({
      userId: buyerId,
      type: STALE_PROJECT_TYPE,
      title: "Your project needs attention",
      message:
        `"${project.title}" hasn't received any proposals yet. Edit the brief or share it to attract freelancers.`,
      actionUrl: notificationService.projectActionUrl(project._id),
      relatedEntity: { type: "project", id: project._id },
    });
    flagged += 1;
  }

  return { flagged };
};

/**
 * The contract auto-releases a milestone once `isReviewLapsed` is true, but
 * nothing has to call `claimMilestone` for that to happen. This job does.
 *
 * Safety notes:
 *   - The contract is still the authority: it rejects the claim unless the
 *     review window really lapsed, so an early/duplicate run cannot pay out.
 *   - `releaseMilestone` only records the release after seeing a matching
 *     `MilestoneClaimed` event, so a partial failure cannot desync the DB.
 *   - `AUTO_RELEASE_ESCROW` defaults to OFF so existing behaviour is unchanged.
 */
const autoReleaseLapsedMilestones = async () => {
  if (!/^(1|true|yes)$/i.test(String(process.env.AUTO_RELEASE_ESCROW || ""))) {
    return { released: 0, skipped: "AUTO_RELEASE_ESCROW disabled" };
  }

  const projects = await Project.find({
    status: "in_progress",
    onChainProjectId: { $exists: true, $ne: null },
  })
    .select("_id buyerId hiredSellerId onChainProjectId")
    .lean();

  let released = 0;
  for (const project of projects) {
    if (!project.hiredSellerId) continue;

    let lapsed = false;
    try {
      lapsed = await chainService.isReviewLapsed(project.onChainProjectId);
    } catch (error) {
      console.error(`[job] auto-release check failed for ${project._id}:`, error.message);
      continue;
    }
    if (!lapsed) continue;

    // Claiming is strictly sequential, so there is at most one deliverable
    // awaiting a decision at a time.
    const milestone = await Milestone.findOne({ projectId: project._id, status: "submitted" })
      .sort({ createdAt: 1 })
      .populate("buyerId")
      .populate("sellerId");
    if (!milestone?.onChainMilestoneId) continue;

    try {
      const fullProject = await Project.findById(project._id);
      const result = await escrowService.releaseMilestone({
        milestone,
        project: fullProject,
        actorKey: null, // resolved to the client's or freelancer's stored key
      });
      released += 1;
      const sellerId = String(project.hiredSellerId._id || project.hiredSellerId);
      await notificationService.createNotification({
        userId: sellerId,
        type: AUTO_RELEASED_TYPE,
        title: "Escrow released automatically",
        message:
          "Your client's review window lapsed, so the escrow for this milestone was released to you.",
        priority: "high",
        actionUrl: notificationService.projectActionUrl(project._id),
        relatedEntity: { type: "project", id: project._id },
      });
      console.log(`[job] auto-released milestone ${result.milestone?._id} on project ${project._id}`);
    } catch (error) {
      console.error(`[job] auto-release failed for project ${project._id}:`, error.message);
    }
  }

  return { released };
};

module.exports = { flagLapsedReviews, flagStaleProjects, autoReleaseLapsedMilestones };