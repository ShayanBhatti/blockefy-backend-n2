/**
 * Escrow Smart Contract health check.
 *   node scripts/escrow-health.js
 *
 * Verifies chain reachability, contract code presence & balance, per-project
 * DB-vs-on-chain escrow figures, and orphaned ledger rows.
 * Exit code 0 = ok, 1 = issues found.
 */
require("dotenv").config();
const connectDB = require("../src/config/db");
const chainService = require("../src/services/chain.service");
const Project = require("../src/models/Project");
const Milestone = require("../src/models/Milestone");
const Transaction = require("../src/models/Transaction");

const rows = [];

const record = (section, status, message) => rows.push([section, status, message]);

(async () => {
  await connectDB();

  const available = await chainService.isChainAvailable();
  if (!available) {
    record("chain-available", "FAIL", `RPC unreachable at ${chainService.RPC_URL}`);
    return finish();
  }
  record("chain-available", "PASS", chainService.RPC_URL);

  const code = await chainService.getProvider().getCode(chainService.CONTRACT_ADDRESS);
  if (!code || code === "0x" || code === "0x0") {
    record("contract-code", "FAIL", `No contract deployed at ${chainService.CONTRACT_ADDRESS} (0x...)`);
    return finish();
  }
  record("contract-code", "PASS", chainService.CONTRACT_ADDRESS);

  const balance = await chainService.getProvider().getBalance(chainService.CONTRACT_ADDRESS);
  const block = await chainService.getProvider().getBlockNumber();
  record("contract-balance", "PASS", `${chainService.toEth(balance)} ETH held`);
  record("chain-block", "INFO", `block #${block}`);

  const projects = await Project.find({ onChainProjectId: { $ne: null } }).lean();
  const projectIds = projects.map((p) => p._id);

  if (projects.length === 0) {
    record("project-scan", "INFO", "No on-chain project references in DB");
  }

  for (const p of projects) {
    let chain;
    try {
      chain = await chainService.getProjectState(p.onChainProjectId);
    } catch (error) {
      chain = undefined;
    }
    if (!chain) {
      record("project", "FAIL", `${p.projectNumber} onChainId=${p.onChainProjectId} -> NO chain record (orphaned)`);
      continue;
    }

    const milestones = await Milestone.find({ projectId: p._id }).lean();
    const fundedEth = milestones
      .filter((m) => m.paymentStatus === "paid")
      .reduce((s, m) => s + (m.amount || 0), 0);
    const releasedEth = milestones
      .filter((m) => m.paymentStatus === "released")
      .reduce((s, m) => s + (m.amount || 0), 0);
    const reconciledEth = fundedEth + releasedEth;
    const ok = Math.abs(chain.totalFundedEth - reconciledEth) < 0.01;

    record(
      "project",
      ok ? "PASS" : "FAIL",
      `${p.projectNumber} chain(funded=${chain.totalFundedEth}, escrow=${chain.escrowEth}) vs db(paid=${fundedEth}, released=${releasedEth})`
    );
  }

  const orphanTxns = await Transaction.countDocuments({
    type: { $in: ["escrow_funded", "escrow_released", "escrow_refunded"] },
    status: { $in: ["completed", "pending", "processing"] },
    projectId: { $nin: projectIds },
  });
  record(
    "orphan-txns",
    orphanTxns === 0 ? "PASS" : "FAIL",
    `${orphanTxns} escrow transaction(s) reference missing projects`
  );

  return finish();
})();

function finish() {
  const issues = rows.filter((r) => r[1] === "FAIL").length;
  rows.forEach(([section, status, message]) => console.log(`${section}: [${status}] ${message}`));
  console.log(`\nEscrow health: ${issues === 0 ? "PASS" : "FAIL"} (${issues} issue${issues === 1 ? "" : "s"})`);
  process.exit(issues === 0 ? 0 : 1);
}