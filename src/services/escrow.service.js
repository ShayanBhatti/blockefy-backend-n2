const mongoose = require("mongoose");
const Milestone = require("../models/Milestone");
const Project = require("../models/Project");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const chainService = require("./chain.service");
const { notifyProject } = require("./notification.service");

/**
 * Escrow service (Blockefy escrow contract).
 *
 * All operations - deposits, releases, refunds, disputes - are RELAYED by the
 * backend using stored user/admin wallet keys. The frontend never signs via
 * MetaMask. Deposits enforce milestone order and are only recorded once the
 * contract emits a `FundsDeposited` event; releases only after a matching
 * `MilestoneClaimed` event.
 */

const TX_CONFIRMATIONS = Number(process.env.TX_CONFIRMATIONS || 1);

const etherNum = (v) => Math.round((Number(v) || 0) * 100) / 100;

const isAdmin = (user) => user?.role === "admin";

const getTransactionsCount = () => Transaction.countDocuments();

/**
 * Resolves a wallet private key usable to relay a transaction: explicit actor
 * key first, then the affected seller's, then the buyer's, then the admin's.
 */
const resolveRelayKey = async ({ actorKey, milestone, project }) => {
  if (actorKey) return actorKey;
  const ids = [];
  if (milestone?.sellerId?._id) ids.push(milestone.sellerId._id);
  if (milestone?.buyerId?._id) ids.push(milestone.buyerId._id);
  if (project?.buyerId) ids.push(project.buyerId);
  for (const id of ids) {
    const u = await User.findById(id).lean();
    if (u?.walletPrivateKey) return u.walletPrivateKey;
  }
  const admin = await User.findOne({ role: "admin" }).lean();
  const adminKey = admin?.walletPrivateKey || process.env.ADMIN_PRIVATE_KEY;
  if (adminKey) return adminKey;
  return null;
};

const getEscrowState = async ({ projectId }) => {
  const project = await Project.findById(projectId);
  if (!project) throw new AppError("Project not found", 404, "NOT_FOUND");
  const milestones = await Milestone.find({ projectId: project._id }).sort({ createdAt: 1 }).lean();

  let chain = null;
  if (project.onChainProjectId) {
    chain = await chainService.getProjectState(project.onChainProjectId);
  }

  return {
    project: {
      _id: project._id,
      projectNumber: project.projectNumber,
      status: project.status,
      onChainProjectId: project.onChainProjectId,
      totalFundedEth: chain ? chain.totalFundedEth : 0,
      escrowEth: chain ? chain.escrowEth : 0,
    },
    milestones: milestones.map((m) => ({
      ...m,
      amountEth: etherNum(m.amount),
    })),
    chain,
  };
};

/**
 * Relayed escrow deposit. Enforces milestone order (the deposited milestone
 * must be the next unpaid milestone in the plan), relays `depositFunds` with
 * the client's stored key (admin fallback), and only records the deposit once
 * the contract emits a matching `FundsDeposited` event.
 */
const createDeposit = async ({ project, user, milestoneId, amountEth }) => {
  if (String(project.buyerId) !== String(user._id) && !isAdmin(user)) {
    throw new AppError("Only the client can deposit into escrow", 403, "FORBIDDEN");
  }
  if (!project.onChainProjectId) {
    throw new AppError("Project has no on-chain escrow. Complete project creation first.", 409, "NO_ONCHAIN");
  }

  const order = await Milestone.find({ projectId: project._id }).sort({ createdAt: 1 }).lean();
  const next = order.find((m) => ["pending", "unpaid"].includes(m.paymentStatus));
  if (!next) {
    throw new AppError("All milestones are already funded", 409, "NO_DEPOSIT_NEEDED");
  }
  if (next._id.toString() !== String(milestoneId)) {
    throw new AppError("Deposit the next unfunded milestone first", 409, "OUT_OF_ORDER");
  }

  const amount = etherNum(amountEth ?? next.amount);
  if (amount !== etherNum(next.amount)) {
    throw new AppError(
      `Deposit amount must equal the milestone amount (${next.amount} ETH)`,
      400,
      "AMOUNT_MISMATCH"
    );
  }

  const key = user.walletPrivateKey || (await resolveRelayKey({ project }));
  if (!key) {
    throw new AppError(
      "No wallet key available to relay the deposit. Link a wallet to your account first.",
      422,
      "NO_RELAY"
    );
  }

  const { txHash, receipt } = await chainService.relayCallAs({
    actorKey: key,
    method: "depositFunds",
    args: [project.onChainProjectId],
    value: chainService.toWei(amount),
  });

  const event = chainService.parseEventFromReceipt(receipt, "FundsDeposited");
  if (!event) {
    throw new AppError(
      "Deposit did not emit a FundsDeposited event and was not applied on the Smart Contract",
      422,
      "TX_NO_EVENT"
    );
  }
  if (Number(event.args.projectId) !== project.onChainProjectId) {
    throw new AppError("Relayed deposit targeted a different project", 422, "TX_MISMATCH");
  }

  const transaction = await Transaction.create({
    transactionNumber: await Transaction.generateTransactionNumber(),
    userId: user._id,
    type: "escrow_funded",
    amount,
    currency: "ETH",
    cryptoAmount: amount,
    cryptoCurrency: "ETH",
    status: "completed",
    projectId: project._id,
    milestoneId: next._id,
    paymentMethod: "wallet",
    blockchain: `hardhat_${chainService.CHAIN_ID}`,
    isEscrow: true,
    escrowStatus: "held",
    txHash,
    fromAddress: receipt.from,
    toAddress: chainService.CONTRACT_ADDRESS,
    completedAt: new Date(),
    description: `Escrow deposit for milestone "${next.title}"`,
    metadata: { blockNumber: receipt.blockNumber },
  });

  const milestone = await Milestone.findByIdAndUpdate(
    next._id,
    { paymentStatus: "paid", escrowTxId: transaction._id, status: "funded" },
    { new: true }
  );

  await notifyProject.depositCompleted(project.buyerId, project._id);
  if (milestone?.sellerId) {
    await notifyProject.milestoneFunded(milestone.sellerId, project._id, milestone._id);
  }

  return { transaction, milestone };
};

/**
 * Finalizes a client-signed deposit after the wallet txHash is submitted.
 */
const confirmDeposit = async ({ project, user, milestoneId, txHash }) => {
  if (String(project.buyerId) !== String(user._id) && !isAdmin(user)) {
    throw new AppError("Only the client can confirm a deposit", 403, "FORBIDDEN");
  }
  if (!txHash) throw new AppError("txHash is required", 400, "VALIDATION");

  const milestone = await Milestone.findById(milestoneId);
  if (!milestone || String(milestone.projectId) !== String(project._id)) {
    throw new AppError("Milestone not found on this project", 404, "NOT_FOUND");
  }

  const existing = await Transaction.findOne({ projectId: project._id, milestoneId, type: "escrow_funded", status: "completed", txHash });
  if (existing) {
    return { transaction: existing, milestone, alreadyConfirmed: true };
  }

  const receipt = await chainService.getProvider().getTransactionReceipt(txHash);
  if (!receipt || Number(receipt.status) !== 1) {
    throw new AppError("Transaction not found or failed on-chain", 422, "TX_FAILED");
  }
  const event = chainService.parseEventFromReceipt(receipt, "FundsDeposited");
  if (!event) {
    throw new AppError(
      "Transaction did not emit a FundsDeposited event and was not applied to the Smart Contract",
      422,
      "TX_NO_EVENT"
    );
  }
  if (Number(event.args.projectId) !== project.onChainProjectId) {
    throw new AppError("Transaction is for a different project", 422, "TX_MISMATCH");
  }

  const transaction = await Transaction.findOneAndUpdate(
    { projectId: project._id, milestoneId, type: "escrow_funded", status: "pending" },
    {
      status: "completed",
      txHash,
      fromAddress: receipt.from,
      toAddress: chainService.CONTRACT_ADDRESS,
      escrowStatus: "held",
      completedAt: new Date(),
      metadata: { blockNumber: receipt.blockNumber },
    },
    { new: true }
  );

  let txnDoc = transaction;
  if (!txnDoc) {
    txnDoc = await Transaction.create({
      transactionNumber: await Transaction.generateTransactionNumber(),
      userId: user._id,
      type: "escrow_funded",
      amount: etherNum(milestone.amount),
      currency: "ETH",
      cryptoAmount: etherNum(milestone.amount),
      cryptoCurrency: "ETH",
      status: "completed",
      projectId: project._id,
      milestoneId: milestone._id,
      paymentMethod: "wallet",
      blockchain: `hardhat_${chainService.CHAIN_ID}`,
      isEscrow: true,
      escrowStatus: "held",
      txHash,
      fromAddress: receipt.from,
      toAddress: chainService.CONTRACT_ADDRESS,
      completedAt: new Date(),
      description: `Escrow deposit for milestone "${milestone.title}"`,
      metadata: { blockNumber: receipt.blockNumber },
    });
  }

  milestone.paymentStatus = "paid";
  milestone.escrowTxId = txnDoc._id;
  milestone.status = "funded";
  await milestone.save();

  await notifyProject.depositCompleted(project.buyerId, project._id);
  await notifyProject.milestoneFunded(milestone.sellerId, project._id, milestone._id);

  return { transaction: txnDoc, milestone, alreadyConfirmed: false };
};

/**
 * Releases a claimed milestone payment. Called after client approval OR by the
 * auto-claim job once the review window lapses.
 */
const releaseMilestone = async ({ milestone, actorKey, project }) => {
  if (!milestone.onChainMilestoneId) {
    throw new AppError("Milestone has no on-chain reference", 409, "NO_ONCHAIN");
  }
  const p = project || (await Project.findById(milestone.projectId._id || milestone.projectId));
  if (!p?.onChainProjectId) throw new AppError("Project has no on-chain escrow", 409, "NO_ONCHAIN");

  const key = await resolveRelayKey({ actorKey, milestone, project: p });
  if (!key) {
    throw new AppError("No wallet key available to relay the release", 422, "NO_RELAY");
  }

  const { txHash, receipt } = await chainService.relayCallAs({
    actorKey: key,
    method: "claimMilestone",
    args: [p.onChainProjectId, milestone.onChainMilestoneId],
  });

  const claimed = chainService.parseEventFromReceipt(receipt, "MilestoneClaimed");
  if (
    !claimed ||
    Number(claimed.args.projectId) !== p.onChainProjectId ||
    Number(claimed.args.milestoneId) !== milestone.onChainMilestoneId
  ) {
    throw new AppError(
      "Milestone was not claimed on the Smart Contract; the release was not applied",
      422,
      "RELEASE_NOT_APPLIED"
    );
  }

  const freelancerId = milestone.sellerId?._id || milestone.sellerId;
  const transaction = new Transaction({
    transactionNumber: await Transaction.generateTransactionNumber(),
    userId: freelancerId,
    type: "escrow_released",
    amount: etherNum(milestone.amount),
    currency: "ETH",
    cryptoAmount: etherNum(milestone.amount),
    cryptoCurrency: "ETH",
    status: "completed",
    projectId: p._id,
    milestoneId: milestone._id,
    paymentMethod: "wallet",
    blockchain: `hardhat_${chainService.CHAIN_ID}`,
    isEscrow: true,
    escrowStatus: "released",
    txHash: receipt.hash,
    fromAddress: chainService.CONTRACT_ADDRESS,
    toAddress: receipt.to || chainService.CONTRACT_ADDRESS,
    completedAt: new Date(),
    description: `Milestone "${milestone.title}" released from escrow`,
  });
  await transaction.save();

  milestone.paymentStatus = "released";
  milestone.releaseTxId = transaction._id;
  milestone.status = "completed";
  milestone.completedAt = new Date();
  await milestone.save();

  const allReleased = await Milestone.countDocuments({
    projectId: p._id,
    paymentStatus: { $ne: "released" },
    status: { $ne: "cancelled" },
  });
  if (allReleased === 0) {
    p.status = "completed";
    p.completedAt = new Date();
    p.metadata = { ...(p.metadata || {}), lastReleaseTx: receipt.hash };
    await p.save();
  }

  await notifyProject.paymentReleased(freelancerId, p._id, milestone._id);

  return { milestone, project: p, transaction };
};

/**
 * Refunds a project's escrow to the client after the deadline has passed
 * (contract enforces `deadline`).
 */
const refund = async ({ project, user, reason }) => {
  if (String(project.buyerId) !== String(user._id) && !isAdmin(user)) {
    throw new AppError("Only the client can retrieve funds", 403, "FORBIDDEN");
  }
  if (!project.onChainProjectId) {
    throw new AppError("Project has no on-chain escrow", 409, "NO_ONCHAIN");
  }
  if (!user.walletPrivateKey) {
    throw new AppError("No wallet key available to relay the refund. Date or milestone constraints may apply.", 422, "NO_RELAY");
  }

  const receipt = await chainService.relayCallAs({
    actorKey: user.walletPrivateKey,
    method: "retrieveFunds",
    args: [project.onChainProjectId],
  }).then((r) => r.receipt);

  await Milestone.updateMany(
    { projectId: project._id, paymentStatus: "paid" },
    { $set: { status: "cancelled", paymentStatus: "refunded", cancelReason: reason || "Escrow refunded to client" } }
  );

  const txn = new Transaction({
    transactionNumber: await Transaction.generateTransactionNumber(),
    userId: project.buyerId,
    type: "escrow_refunded",
    amount: etherNum(0), // exact amount updated below from chain escrow
    currency: "ETH",
    cryptoCurrency: "ETH",
    status: "completed",
    projectId: project._id,
    paymentMethod: "wallet",
    blockchain: `hardhat_${chainService.CHAIN_ID}`,
    isEscrow: true,
    escrowStatus: "refunded",
    txHash: receipt.hash,
    fromAddress: chainService.CONTRACT_ADDRESS,
    toAddress: receipt.to || chainService.CONTRACT_ADDRESS,
    completedAt: new Date(),
    description: `Escrow refunded: ${reason || "deadline passed"}`,
  });
  await txn.save();

  project.status = "cancelled";
  project.cancelledAt = new Date();
  project.cancelReason = reason || "Escrow refunded to client";
  await project.save();

  await notifyProject.paymentRefunded(project.buyerId, project._id);

  return { project, transaction: txn };
};

/** Admin only: locks a project for dispute resolution. */
const openDispute = async ({ project, adminKey, reason }) => {
  if (!project.onChainProjectId) throw new AppError("Project has no on-chain escrow", 409, "NO_ONCHAIN");
  const key = adminKey || process.env.ADMIN_PRIVATE_KEY || (await resolveRelayKey({ project }));
  if (!key) throw new AppError("No admin wallet key available", 422, "NO_RELAY");

  const receipt = await chainService.relayCallAs({
    actorKey: key,
    method: "openDispute",
    args: [project.onChainProjectId],
  }).then((r) => r.receipt);

  project.status = "disputed";
  project.metadata = { ...(project.metadata || {}), disputeTxHash: receipt.hash, disputeReason: reason || null };
  await project.save();

  await Milestone.updateMany({ projectId: project._id }, { $set: { status: "disputed" } });
  await notifyProject.disputeOpened(project._id, project.buyerId, project.hiredSellerId);

  return { project };
};

/** Admin only: final ruling (release to freelancer or refund to client). */
const resolveDispute = async ({ project, adminKey, toFreelancer }) => {
  if (!project.onChainProjectId) throw new AppError("Project has no on-chain escrow", 409, "NO_ONCHAIN");
  const key = adminKey || process.env.ADMIN_PRIVATE_KEY || (await resolveRelayKey({ project }));
  if (!key) throw new AppError("No admin wallet key available", 422, "NO_RELAY");

  const receipt = await chainService.relayCallAs({
    actorKey: key,
    method: "resolveDispute",
    args: [project.onChainProjectId, Boolean(toFreelancer)],
  }).then((r) => r.receipt);

  const status = toFreelancer ? "completed" : "cancelled";
  project.status = status;
  if (status === "completed") project.completedAt = new Date();
  if (status === "cancelled") project.cancelledAt = new Date();
  project.metadata = { ...(project.metadata || {}), disputeResolvedTx: receipt.hash, disputeRulingFreelancer: Boolean(toFreelancer) };
  await project.save();

  await Milestone.updateMany(
    { projectId: project._id },
    { $set: { status: toFreelancer ? "completed" : "cancelled", paymentStatus: toFreelancer ? "released" : "refunded" } }
  );

  if (toFreelancer) {
    await notifyProject.paymentReleased(project.hiredSellerId, project._id, null);
  } else {
    await notifyProject.paymentRefunded(project.buyerId, project._id);
  }

  return { project };
};

module.exports = {
  getEscrowState,
  createDeposit,
  confirmDeposit,
  releaseMilestone,
  refund,
  openDispute,
  resolveDispute,
  resolveRelayKey,
  getTransactionsCount,
};