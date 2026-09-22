/**
 * Background jobs for the projects / escrow system.
 *
 * Run from src/jobs/index.js on the in-process scheduler. Both jobs are
 * read-only + best-effort: they never change project/milestone state, only
 * remind people. Chains that are down or projects without on-chain escrow are
 * skipped silently.
 */

const Project = require("../models/Project");
const Milestone = require("../models/Milestone");
const Notification = require("../models/Notification");
const chainService = require("../services/chain.service");
const notificationService = require("../services/notification.service");

const LAPSED_REVIEW_TYPE = "review_window_lapsed";
const STALE_PROJECT_TYPE = "project_stale";

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

module.exports = { flagLapsedReviews, flagStaleProjects };