/**
 * Reconciles the escrow ledger with on-chain truth.
 *
 *   node scripts/reconcile-escrow.js            # DRY RUN (prints what would change)
 *   node scripts/reconcile-escrow.js --apply    # apply changes + re-push projects to a fresh chain
 *
 * For every project whose on-chain record is missing (orphaned after a chain
 * reset / redeploy):
 *   - legacy escrow transactions are marked `cancelled` (audit row kept, metadata explains why),
 *   - dependent milestones are reset to pending/unpaid (escrow/release refs cleared),
 *   - a project that was `completed` is revived to `in_progress`,
 *   - with --apply, the project is re-pushed to the chain as a Milestones
 *     project (createProject), the freelancer is re-assigned on-chain
 *     (approveProject) and its milestones re-created (createMilestone).
 *
 * Orphaned projects are snapshotted BEFORE any relay so mid-run chain updates
 * can never make a stale id look valid again.
 */
require("dotenv").config();
const connectDB = require("../src/config/db");
const chainService = require("../src/services/chain.service");
const Project = require("../src/models/Project");
const Milestone = require("../src/models/Milestone");
const Transaction = require("../src/models/Transaction");
const User = require("../src/models/User");

const APPLY = process.argv.includes("--apply");
const log = (...a) => console.log(...a);

const describe = (doc, changes) => {
  const next = { ...doc.toObject(), ...changes };
  if (changes.metadata) next.metadata = { ...(doc.metadata || {}), ...changes.metadata };
  return { id: doc._id, model: doc.constructor.modelName, next };
};

const persist = async (plans) => {
  for (const [doc, changes] of plans) {
    Object.assign(doc, changes);
    await doc.save();
  }
};

(async () => {
  await connectDB();
  log(APPLY ? "RECONCILE --apply (writes DB + relays re-push)" : "RECONCILE DRY RUN (read-only)");

  const summary = {
    orphanedProjects: 0,
    transactionsCancelled: 0,
    milestonesReset: 0,
    revived: 0,
    repushedProjects: 0,
    projectsApproved: 0,
    milestoneRepushed: 0,
    skippedFreelancer: 0,
    noBuyerKey: 0,
    errors: [],
  };

  // ---- 1. Snapshot orphans + build the full change plan (no relays yet) ----
  const candidates = await Project.find({
    onChainProjectId: { $ne: null },
    status: { $ne: "cancelled" },
  }).lean();

  const orphans = [];
  for (const p of candidates) {
    let chain;
    try {
      chain = await chainService.getProjectState(p.onChainProjectId);
    } catch (error) {
      chain = undefined;
    }
    if (chain) continue;
    orphans.push(p);
  }
  log(`Snapshot: ${orphans.length} orphaned project(s) (of ${candidates.length} with chain refs)`);

  for (const p of orphans) {
    summary.orphanedProjects += 1;
    log(`\n[orphaned] ${p.projectNumber} (db onChainId=${p.onChainProjectId}, status=${p.status})`);

    const plans = [];

    // Transactions -> cancelled
    const escrowTxns = await Transaction.find({
      projectId: p._id,
      type: { $in: ["escrow_funded", "escrow_released", "escrow_refunded"] },
      status: { $in: ["completed", "pending", "processing"] },
    });
    for (const t of escrowTxns) {
      const changes = {
        status: "cancelled",
        metadata: {
          ...(t.metadata || {}),
          reconcileReason: "chain reset / orphaned on-chain record",
          reconciledAt: new Date().toISOString(),
        },
      };
      plans.push([t, changes]);
      summary.transactionsCancelled += 1;
      log(`   txn ${t._id} (${t.type}) -> cancelled`);
    }

    // Milestones -> reset
    const milestones = await Milestone.find({ projectId: p._id });
    for (const m of milestones) {
      const changes = {
        status: "pending",
        paymentStatus: "unpaid",
        escrowTxId: null,
        releaseTxId: null,
        completedAt: null,
        onChainMilestoneId: null,
        revisionRequests: [],
      };
      plans.push([m, changes]);
      summary.milestonesReset += 1;
      log(`   milestone "${m.title}" reset`);
    }

    // Project -> revive completed ones
    const projectChanges = {};
    if (p.status === "completed") {
      projectChanges.status = "in_progress";
      projectChanges.completedAt = null;
      summary.revived += 1;
      log(`   project revived: completed -> in_progress`);
    }

    // Keys for the re-push
    const buyer = p.buyerId ? await User.findById(p.buyerId).lean() : null;
    const buyerKey = buyer?.walletPrivateKey;
    const seller = p.hiredSellerId ? await User.findById(p.hiredSellerId).lean() : null;
    const sellerKey = seller?.walletPrivateKey;
    const sellerAddress = seller?.walletAddress || (sellerKey ? chainService.getSigner(sellerKey).address : null);

    if (!buyerKey) summary.noBuyerKey += 1;

    if (!APPLY) {
      log(
        buyerKey
          ? `   would re-push (createProject -> approveProject -> createMilestone) ${
              milestones.length ? `with ${milestones.length} milestone(s)` : "(no milestones)"
            }`
          : "   ! no buyer key; re-push skipped"
      );
      if (sellerKey) log(`   freelancer ${sellerAddress}`);
      else if (p.hiredSellerId) log("   ! freelancer has no wallet key/address");
      continue;
    }

    // ---- 2. Apply ----------
    try {
      await chainService.assertChainAvailable();

      // createProject (client)
      const { receipt } = await chainService.relayCallAs({
        actorKey: buyerKey,
        method: "createProject",
        args: [1, p.projectNumber],
      });
      const created = chainService.parseEventFromReceipt(receipt, "ProjectCreated");
      const newProjectId = created ? Number(created.args.projectId) : await chainService.getProjectCounter();
      projectChanges.onChainProjectId = newProjectId;
      if (receipt.hash) projectChanges.metadata = {
        ...(p.metadata || {}),
        createTxHash: receipt.hash,
        reconciledAt: new Date().toISOString(),
      };
      summary.repushedProjects += 1;
      log(`   re-pushed ${p.projectNumber} -> onChainId=${newProjectId}`);

      // approveProject (client) / only when hired + freelancer address known
      if (p.hiredSellerId && sellerAddress) {
        const { receipt: approveReceipt } = await chainService.relayCallAs({
          actorKey: buyerKey,
          method: "approveProject",
          args: [newProjectId, sellerAddress],
        });
        summary.projectsApproved += 1;
        log(`   assigned freelancer ${sellerAddress}`);
        if (approveReceipt.hash) {
          projectChanges.metadata = {
            ...(projectChanges.metadata || {}),
            approveTxHash: approveReceipt.hash,
          };
        }
      } else if (p.hiredSellerId) {
        summary.skippedFreelancer += 1;
        log("   ! hired but freelancer has no wallet address; funds cannot flow");
      }

      await Project.updateOne({ _id: p._id }, { $set: projectChanges });

      // createMilestone per reset milestone (freelancer) - only for Milestones projects
      if (sellerKey) {
        for (const m of await Milestone.find({ projectId: p._id, status: "pending" })) {
          try {
            const { receipt: mReceipt } = await chainService.relayCallAs({
              actorKey: sellerKey,
              method: "createMilestone",
              args: [
                newProjectId,
                String(m.title || "Milestone").slice(0, 200),
                chainService.toWei(m.amount),
              ],
            });
            const mCreated = chainService.parseEventFromReceipt(mReceipt, "MilestoneCreated");
            const milestoneId = mCreated ? Number(mCreated.args.milestoneId) : await chainService.getMilestoneCounter();
            m.onChainMilestoneId = milestoneId;
            await m.save();
            summary.milestoneRepushed += 1;
            log(`   milestone "${m.title}" -> onChainMilestoneId=${milestoneId}`);
          } catch (error) {
            summary.errors.push(`${p.projectNumber} milestone ${m.title}: ${error.message}`);
            console.error(`   ! milestone re-push failed: ${error.message}`);
          }
        }
      } else if (p.hiredSellerId) {
        summary.skippedFreelancer += 1;
        log("   ! no freelancer key; milestone rows kept off-chain");
      }
    } catch (error) {
      summary.errors.push(`${p.projectNumber}: ${error.message}`);
      console.error(`   ! project re-push failed: ${error.message}`);
    }

    // Persist transaction/milestone change plans tied to this project.
    if (plans.length) await persist(plans);
  }

  // ---- 3. Milestone sync: pending milestone rows without an on-chain ref ------
  // Handles milestones that were reset to pending but not re-pushed (e.g. when a
  // project reset and a relay pass already ran for a previous run of this script).
  const syncedProjects = await Project.find({
    onChainProjectId: { $ne: null },
    status: { $in: ["in_progress", "open"] },
  }).lean();

  for (const p of syncedProjects) {
    let chain;
    try {
      chain = await chainService.getProjectState(p.onChainProjectId);
    } catch (error) {
      chain = undefined;
    }
    if (!chain) continue;
    // createMilestone is only allowed while the on-chain project is Created(0) or Funded(1).
    if (chain.statusCode !== 0 && chain.statusCode !== 1) continue;

    const missing = await Milestone.find({ projectId: p._id, onChainMilestoneId: null, status: "pending" });
    if (!missing.length) continue;

    const seller = p.hiredSellerId ? await User.findById(p.hiredSellerId).lean() : null;
    const sellerKey = seller?.walletPrivateKey;
    log(`\n[msync] ${p.projectNumber} (onChainId=${p.onChainProjectId}): ${missing.length} milestone(s) without a chain ref`);
    if (!sellerKey) {
      summary.skippedFreelancer += 1;
      log("   ! no freelancer key; skipped");
      continue;
    }
    if (!APPLY) {
      missing.forEach((m) => log(`   would push "${m.title}" (${m.amount} ETH)`));
      continue;
    }

    for (const m of missing) {
      try {
        const { receipt } = await chainService.relayCallAs({
          actorKey: sellerKey,
          method: "createMilestone",
          args: [p.onChainProjectId, String(m.title || "Milestone").slice(0, 200), chainService.toWei(m.amount)],
        });
        const created = chainService.parseEventFromReceipt(receipt, "MilestoneCreated");
        const milestoneId = created ? Number(created.args.milestoneId) : await chainService.getMilestoneCounter();
        m.onChainMilestoneId = milestoneId;
        await m.save();
        summary.milestoneRepushed += 1;
        log(`   "${m.title}" -> onChainMilestoneId=${milestoneId}`);
      } catch (error) {
        summary.errors.push(`${p.projectNumber} msync ${m.title}: ${error.message}`);
        console.error(`   ! ${error.message}`);
      }
    }
  }

  log("\n=== RECONCILE SUMMARY ===");
  log(JSON.stringify(summary, null, 2));
  if (summary.errors.length) log(`\nErrors: ${summary.errors.length}`);
  process.exit(0);
})();