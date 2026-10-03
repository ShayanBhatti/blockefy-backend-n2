#!/usr/bin/env node
/**
 * Service-level end-to-end escrow flow.
 *
 * Drives the REAL backend services (project -> proposal -> milestone -> escrow)
 * instead of poking the contract with raw ethers, so the hardened actor-key
 * authorization in chain.service/escrow.service is actually exercised.
 *
 * Two modes:
 *   --chain=local    (default) in-process ganache + throwaway wallet keys + a
 *                    throwaway Mongo database. Proves the whole wiring with no
 *                    secrets and no real value. Runs anywhere.
 *   --chain=testnet  real BSC testnet + the keys in .env:
 *                      E2E_CLIENT_PRIVATE_KEY       (buyer / onlyClient)
 *                      E2E_FREELANCER_PRIVATE_KEY   (seller / onlyFreelancer)
 *                    Keys must derive the addresses you intend to act as; the
 *                    script refuses to continue if a key/address mismatch or a
 *                    missing key. Never prints key material.
 *
 * Admin-only paths (openDispute/resolveDispute/pause/setTreasury/sweepSurplus)
 * are deliberately NOT exercised here - they need ADMIN_PRIVATE_KEY for the
 * contract owner and are wired separately.
 *
 * Usage:
 *   node scripts/e2e-services-live.js
 *   node scripts/e2e-services-live.js --chain=testnet --keep-db
 */
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");

const artifact = require("../contracts/contractsData/Blockefy.json");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const CHAIN_MODE = arg("chain", "local");
const KEEP_DB = argv.includes("--keep-db");
const DEPOSIT_AMOUNT = Number(arg("deposit", "0.01"));
const MILESTONE_PLAN = [
  { title: "Discovery and wireframes", amount: DEPOSIT_AMOUNT },
  { title: "Core implementation", amount: DEPOSIT_AMOUNT },
  { title: "Testing and handover", amount: DEPOSIT_AMOUNT },
];

const RPC_PORT = Number(arg("port", "18545"));
const LOCAL_RPC = `http://127.0.0.1:${RPC_PORT}`;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
let stepNo = 0;
let failures = 0;

const hr = (t) => console.log(`\n${C.bold}${C.cyan}${"=".repeat(72)}\n${t}\n${"=".repeat(72)}${C.reset}`);
const step = (t) => console.log(`\n${C.bold}[${++stepNo}] ${t}${C.reset}`);
const info = (t) => console.log(`    ${C.dim}${t}${C.reset}`);
const ok = (t) => console.log(`    ${C.green}PASS${C.reset} ${t}`);

function check(label, condition, detail = "") {
  if (condition) {
    ok(label + (detail ? ` ${C.dim}(${detail})${C.reset}` : ""));
  } else {
    failures++;
    console.log(`    ${C.red}FAIL${C.reset} ${label}${detail ? ` ${C.dim}(${detail})${C.reset}` : ""}`);
  }
  return !!condition;
}

/** Asserts that an async call rejects with a message containing `substring`. */
async function expectRejection(label, fn, substring) {
  try {
    await fn();
    failures++;
    console.log(`    ${C.red}FAIL${C.reset} ${label} ${C.dim}- expected rejection "${substring}" but it SUCCEEDED${C.reset}`);
    return false;
  } catch (err) {
    const msg = [err.code, err.shortMessage, err.message, err.reason]
      .filter(Boolean)
      .join(" ");
    if (!substring || msg.includes(substring)) {
      ok(`${label} ${C.dim}rejected as expected${C.reset}`);
      return true;
    }
    failures++;
    console.log(`    ${C.red}FAIL${C.reset} ${label} ${C.dim}- rejected but message did not contain "${substring}": ${msg.replace(/\s+/g, " ").slice(0, 200)}${C.reset}`);
    return false;
  }
}

const short = (a) => {
  if (a === null || a === undefined) return "(none)";
  const s = String(a);
  return s.length <= 12 ? s : `${s.slice(0, 6)}...${s.slice(-4)}`;
};

// ---------------------------------------------------------------------------
// Mongo: always use a THROWAWAY database so the live local DB is never touched
// ---------------------------------------------------------------------------
const E2E_DB_NAME = arg("db", "blockefy_e2e_scratch");

function buildE2EMongoUri() {
  const base = process.env.MONGODB_URI;
  if (!base) throw new Error("MONGODB_URI is not set in .env");
  const u = new URL(base.replace(/\/\?/, "/?"));
  u.pathname = `/${E2E_DB_NAME}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Mode: local chain
// ---------------------------------------------------------------------------
async function startLocalChain() {
  const ganache = require("ganache");
  const deployerKey = ethers.Wallet.createRandom().privateKey;
  const clientKey = ethers.Wallet.createRandom().privateKey;
  const freelancerKey = ethers.Wallet.createRandom().privateKey;
  const outsiderKey = ethers.Wallet.createRandom().privateKey;
  const fundEach = "0x21e19e0c9bab2400000"; // 10000 ETH

  const server = ganache.server({
    wallet: {
      accounts: [deployerKey, clientKey, freelancerKey, outsiderKey].map((secretKey) => ({
        secretKey,
        balance: fundEach,
      })),
    },
    chain: { chainId: 1337 },
    miner: { blockGasLimit: 30_000_000 },
    logging: { quiet: true },
  });

  await server.listen(RPC_PORT);

  const provider = new ethers.JsonRpcProvider(LOCAL_RPC, undefined, { staticNetwork: true });
  const deployer = new ethers.Wallet(deployerKey, provider);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  // constructor(address _treasury); the deployer becomes owner/admin.
  const contract = await factory.deploy(deployer.address);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  return {
    server,
    rpcUrl: LOCAL_RPC,
    chainId: 1337,
    contractAddress: address,
    deployer,
    keys: { clientKey, freelancerKey, outsiderKey },
  };
}

// ---------------------------------------------------------------------------
// Mode: testnet
// ---------------------------------------------------------------------------
const walletFromEnv = (name) => {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing key(s) in .env: ${name}`);
  const trimmed = String(raw).trim();
  if (trimmed.length === 42) {
    throw new Error(
      `${name} in .env looks like a WALLET ADDRESS, not a private key.\n` +
        `  An address is 42 characters and cannot sign; a private key is 66 (0x + 64 hex).\n` +
        `  Export the PRIVATE KEY for the account you intend to use (e.g. MetaMask account > Export private key),\n` +
        `  then put that 66-character value here.`
    );
  }
  if (trimmed.length !== 66) {
    throw new Error(
      `${name} in .env has ${trimmed.length} characters; a private key must be exactly 66 (0x + 64 hex).`
    );
  }
  try {
    return new ethers.Wallet(trimmed);
  } catch (e) {
    throw new Error(`${name} in .env is not a valid private key: ${e.shortMessage || e.message}`);
  }
};

function resolveTestnetKeys() {
  const missing = ["E2E_CLIENT_PRIVATE_KEY", "E2E_FREELANCER_PRIVATE_KEY"].filter(
    (n) => !process.env[n]
  );
  if (missing.length) {
    throw new Error(
      `Missing key(s) in .env: ${missing.join(", ")}\n` +
        `  These sign the buyer-only (onlyClient) and freelancer-only (onlyFreelancer)\n` +
        `  contract calls. Without them the escrow flow cannot be relayed.`
    );
  }
  const client = walletFromEnv("E2E_CLIENT_PRIVATE_KEY");
  const freelancer = walletFromEnv("E2E_FREELANCER_PRIVATE_KEY");
  const outsider = ethers.Wallet.createRandom();
  return {
    clientKey: client.privateKey,
    freelancerKey: freelancer.privateKey,
    outsiderKey: outsider.privateKey,
    client,
    freelancer,
    outsider,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let chainCtx;
  let mongoUri;
  let useScratchDb = true;

  if (CHAIN_MODE === "local") {
    hr("PRE-FLIGHT - local chain (no secrets, no real value)");
    info("starting in-process ganache and deploying contracts/Blockefy.sol");
    chainCtx = await startLocalChain();
    mongoUri = buildE2EMongoUri();
    info(`rpc            ${LOCAL_RPC} (chainId ${chainCtx.chainId})`);
    info(`contract       ${chainCtx.contractAddress}`);
    info(`mongo db       ${E2E_DB_NAME} ${C.dim}(throwaway - live DB untouched)${C.reset}`);
  } else {
    hr("PRE-FLIGHT - BSC testnet (real keys, real testnet BNB)");
    const k = resolveTestnetKeys();
    chainCtx = {
      rpcUrl: null,
      keys: { clientKey: k.clientKey, freelancerKey: k.freelancerKey, outsiderKey: k.outsiderKey },
      derived: { client: k.client.address, freelancer: k.freelancer.address, outsider: k.outsider.address },
    };
    // Use the live database so the run is recorded against the real accounts.
    mongoUri = process.env.MONGODB_URI;
    useScratchDb = false;
    info(`client addr    ${k.client.address}`);
    info(`freelancer     ${k.freelancer.address}`);
    info(`contract       ${process.env.CONTRACT_ADDRESS}`);
    info(`mongo db       ${C.yellow}LIVE (${E2E_DB_NAME === "blockefy_e2e_scratch" ? "default uri" : E2E_DB_NAME})${C.reset}`);
  }

  // chain.service reads its configuration at require time, so the environment
  // must be fully populated BEFORE any service module is loaded.
  if (CHAIN_MODE === "local") {
    process.env.RPC_URL = chainCtx.rpcUrl;
    process.env.RPC_URLS = chainCtx.rpcUrl;
    process.env.CHAIN_ID = String(chainCtx.chainId);
    process.env.CONTRACT_ADDRESS = chainCtx.contractAddress;
  }
  process.env.MONGODB_URI = mongoUri;
  delete process.env.TEST_MONGODB_URI;

  const mongoose = require("mongoose");
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 20000 });

  // Drop any leftovers from a previous run so counters/ids are deterministic.
  if (useScratchDb) {
    await mongoose.connection.dropDatabase();
    info("dropped scratch database");
  }

  // Services pull in their models on require; require them after the DB is live.
  const projectService = require("../src/services/project.service");
  const proposalService = require("../src/services/proposal.service");
  const milestoneService = require("../src/services/milestone.service");
  const escrowService = require("../src/services/escrow.service");
  const chainService = require("../src/services/chain.service");
  const User = mongoose.model("User");
  const Project = mongoose.model("Project");
  const Milestone = mongoose.model("Milestone");
  const Transaction = mongoose.model("Transaction");
  const Notification = mongoose.model("Notification");

  hr("STEP 0 - chain + actor verification");

  const verification = await chainService.verifyDeployedContract();
  check("deployed bytecode matches contracts/Blockefy.sol", verification.valid !== false, verification.reason || "");
  const owner = await chainService.getContractOwner();
  info(`contract owner ${owner}`);

  const provider = chainService.getProvider();
  const keyFor = (role) => chainCtx.keys[`${role}Key`] || chainCtx.keys[role];
  const actors = {
    client: keyFor("client"),
    freelancer: keyFor("freelancer"),
    outsider: keyFor("outsider"),
  };
  const derived = {};
  const bal = {};
  for (const [who, key] of Object.entries(actors)) {
    derived[who] = new ethers.Wallet(key).address;
    bal[who] = await provider.getBalance(derived[who]);
    info(`${who.padEnd(12)} ${derived[who]}  ${ethers.formatEther(bal[who])} ETH`);
  }
  check(
    "client and freelancer can pay gas",
    bal.client > ethers.parseEther("0.05") && bal.freelancer > ethers.parseEther("0.01"),
    `client ${ethers.formatEther(bal.client)}`
  );
  check("client and freelancer are distinct accounts", derived.client !== derived.freelancer);

  // ---- accounts -----------------------------------------------------------
  step("create/attach the two Mongo accounts that own those keys");
  const stamp = Date.now();
  const mkUser = async ({ role, key, label }) => {
    const address = new ethers.Wallet(key).address;
    const email = `e2e.${label}.${stamp}@blockefy.local`;
    let user = await User.findOne({ walletAddress: address });
    if (!user) {
      user = new User({
        email,
        fullName: `E2E ${label}`,
        username: `e2e_${label}_${stamp}`,
        role,
        walletAddress: address,
        walletPrivateKey: key,
        emailVerified: true,
        isSuspended: false,
        onboardingStep: 4,
      });
    } else {
      user.role = role;
      user.walletPrivateKey = key;
    }
    await user.save();
    info(`${label.padEnd(10)} ${user.email} -> ${short(address)}`);
    return user;
  };
  const buyer = await mkUser({ role: "buyer", key: actors.client, label: "client" });
  const seller = await mkUser({ role: "seller", key: actors.freelancer, label: "freelancer" });
  const outsider = await mkUser({ role: "seller", key: actors.outsider, label: "outsider" });
  check("client account holds its private key", !!buyer.walletPrivateKey);
  check("freelancer account holds its private key", !!seller.walletPrivateKey);

  // ---- 1. create project --------------------------------------------------
  step("client creates the project (relays createProject on-chain)");
  const { project } = await projectService.createProject({
    user: buyer,
    body: {
      title: `E2E escrow ${stamp}`,
      description: "Service-level end-to-end escrow verification.",
      category: "Development",
      projectType: "hourly",
      onChainProjectType: "milestones",
      budget: { min: 0.01, max: Number(DEPOSIT_AMOUNT) * MILESTONE_PLAN.length, currency: "ETH" },
      duration: 14,
      skills: ["solidity", "testing"],
      experienceLevel: "intermediate",
      deadline: new Date(Date.now() + 14 * 86400000).toISOString(),
    },
  });
  check("project has an on-chain id", !!project.onChainProjectId, `#${project.onChainProjectId}`);
  check("project is open for proposals", project.status === "open", project.status);
  const pid = project.onChainProjectId;
  info(`onChainProjectId=${pid} status=${project.status}`);

  // ---- 2. proposal --------------------------------------------------------
  step("freelancer submits a proposal (off-chain)");
  const { proposal } = await proposalService.createProposal({
    user: seller,
    projectId: project._id,
    body: {
      bidAmount: Number(DEPOSIT_AMOUNT) * MILESTONE_PLAN.length,
      coverLetter: "E2E proposal covering the full milestone plan.",
      estimatedDuration: 14,
      deliveryDays: 14,
      termsAccepted: true,
      milestones: MILESTONE_PLAN.map((m, i) => ({ ...m, order: i + 1 })),
    },
  });
  check("proposal recorded", !!proposal && !!proposal._id, `status=${proposal.status}`);

  // ---- 3. accept ----------------------------------------------------------
  step("client accepts the proposal (relays approveProject, assigns freelancer)");
  const accepted = await proposalService.acceptProposal({ user: buyer, proposalId: proposal._id });
  const fresh = await Project.findById(project._id);
  check("freelancer assigned on-chain", !!(fresh.hiredSellerId && String(fresh.hiredSellerId) === String(seller._id)));
  check("project is in progress", fresh.status === "in_progress", fresh.status);
  const onChain = await chainService.getProject(pid);
  check("contract shows the freelancer", String(onChain.freelancer).toLowerCase() === derived.freelancer.toLowerCase(), short(onChain.freelancer));

  // ---- 4. milestones ------------------------------------------------------
  step("freelancer creates milestones (relays createMilestone)");
  const milestones = [];
  for (const plan of MILESTONE_PLAN) {
    const { milestone } = await milestoneService.createMilestone({
      user: seller,
      projectId: project._id,
      body: { title: plan.title, amount: plan.amount, description: plan.title },
    });
    await milestone.save === undefined;
    check(`milestone "${plan.title}" on-chain`, !!milestone.onChainMilestoneId, `#${milestone.onChainMilestoneId}`);
    milestones.push(milestone);
  }
  const ids = await chainService.getProjectMilestoneIds(pid);
  check("contract recorded every milestone", ids.length === MILESTONE_PLAN.length, `${ids.length} on-chain`);

  // ---- 5. deposits --------------------------------------------------------
  step("client funds each milestone in order (relays depositFunds with value)");
  for (const m of milestones) {
    const freshM = await Milestone.findById(m._id);
    const { milestone: funded, transaction } = await escrowService.createDeposit({
      project: await Project.findById(project._id),
      user: buyer,
      milestoneId: freshM._id,
      amountEth: freshM.amount,
    });
    check(`deposited ${freshM.amount} for "${freshM.title}"`, funded.paymentStatus === "paid" && funded.status === "funded");
    check(`transaction recorded (${short(transaction.txHash)})`, transaction.status === "completed");
  }
  const escrowed = await chainService.getTotalEscrowed();
  const expectedEscrow = ethers.parseEther(String(DEPOSIT_AMOUNT * MILESTONE_PLAN.length));
  check(
    "escrow balance matches the sum of deposits",
    escrowed === expectedEscrow,
    `${ethers.formatEther(escrowed)} vs ${ethers.formatEther(expectedEscrow)}`
  );

  // ---- 6. submit / revise / approve --------------------------------------
  step("first milestone: submit -> request changes -> resubmit -> approve");
  const m1 = milestones[0];
  await milestoneService.submitMilestone({
    milestoneId: m1._id,
    user: seller,
    data: { url: "https://example.invalid/deliverable-v1", description: "First delivery", files: [] },
  });
  check("milestone marked submitted", (await Milestone.findById(m1._id)).status === "submitted");

  await milestoneService.requestRevision({
    milestoneId: m1._id,
    user: buyer,
    reason: "Please tighten the annotations.",
    extraDays: 3,
  });
  const revised = await Milestone.findById(m1._id);
  check("revision requested reopens the milestone", revised.status === "revision_requested", revised.status);

  await milestoneService.resubmitMilestone({
    milestoneId: m1._id,
    user: seller,
    data: { url: "https://example.invalid/deliverable-v2", description: "Revised delivery", files: [] },
  });
  check("resubmission accepted", (await Milestone.findById(m1._id)).status === "submitted");

  const sellerBefore = await provider.getBalance(derived.freelancer);
  await milestoneService.approveMilestone({ milestoneId: m1._id, user: buyer });
  const released = await Milestone.findById(m1._id);
  check("milestone released", released.paymentStatus === "released" || released.status === "released", `${released.status}/${released.paymentStatus}`);
  const sellerAfter = await provider.getBalance(derived.freelancer);
  check("freelancer was paid", sellerAfter > sellerBefore, `+${ethers.formatEther(sellerAfter - sellerBefore)}`);

  // ---- 7. remaining milestones ------------------------------------------
  step("client approves the remaining milestones");
  for (const m of milestones.slice(1)) {
    const { milestone: cur } = await milestoneService.getMilestoneById({ milestoneId: m._id }).then((r) => ({ milestone: r }));
    await milestoneService.submitMilestone({
      milestoneId: cur._id,
      user: seller,
      data: { url: `https://example.invalid/${short(cur._id)}`, description: "Delivery", files: [] },
    });
    await milestoneService.approveMilestone({ milestoneId: cur._id, user: buyer });
    check(`released "${cur.title}"`, (await Milestone.findById(cur._id)).paymentStatus === "released");
  }

  const projectAfter = await Project.findById(project._id);
  check("project completed on-chain", projectAfter.status === "completed", projectAfter.status);
  const chainAfter = await chainService.getProject(pid);
  check("contract agrees the project is complete", Number(chainAfter.status) === 3, `status=${Number(chainAfter.status)}`);

  // ---- 8. negative / authorization tests ---------------------------------
  step("authorization: wrong-actor calls must be refused");
  const openProject = await Project.findById(project._id);
  await expectRejection(
    "freelancer cannot deposit (onlyClient on-chain)",
    () =>
      escrowService.createDeposit({
        project: openProject,
        user: seller,
        milestoneId: MILESTONE_PLAN.length ? (milestones[0]._id) : null,
        amountEth: DEPOSIT_AMOUNT,
      }),
    "FORBIDDEN"
  );
  await expectRejection(
    "client cannot create milestones (not the hired freelancer)",
    () =>
      milestoneService.createMilestone({
        user: buyer,
        projectId: project._id,
        body: { title: "unauthorised", amount: DEPOSIT_AMOUNT },
      }),
    "FORBIDDEN"
  );
  await expectRejection(
    "unrelated user cannot create milestones",
    () =>
      milestoneService.createMilestone({
        user: outsider,
        projectId: project._id,
        body: { title: "unauthorised", amount: DEPOSIT_AMOUNT },
      }),
    "FORBIDDEN"
  );
  await expectRejection(
    "unrelated user cannot view escrow state (no existence leak)",
    () => escrowService.getEscrowState({ project: openProject, user: outsider }),
    "NOT_FOUND"
  );
  // Contract-level guard: the freelancer's own key cannot deposit directly.
  const freelancerSigner = new ethers.Wallet(actors.freelancer, provider);
  const c = new ethers.Contract(process.env.CONTRACT_ADDRESS, artifact.abi, freelancerSigner);
  await expectRejection(
    "contract rejects depositFunds from the freelancer",
    () => c.depositFunds.staticCall(pid),
    "not the client"
  );
  const outsiderSigner = new ethers.Wallet(actors.outsider, provider);
  const co = new ethers.Contract(process.env.CONTRACT_ADDRESS, artifact.abi, outsiderSigner);
  await expectRejection(
    "contract rejects createMilestone from an outsider",
    () => co.createMilestone.staticCall(pid, "nope", ethers.parseEther("1")),
    "not the freelancer"
  );

  // ---- 9. reconciliation --------------------------------------------------
  step("reconcile database against the chain");
  const txns = await Transaction.find({ projectId: project._id }).lean();
  check("transactions were persisted", txns.length > 0, `${txns.length} rows`);
  const escrowRows = txns.filter((t) => t.type === "escrow_funded" && t.status === "completed");
  check("every deposit has a database row", escrowRows.length === MILESTONE_PLAN.length, `${escrowRows.length}/${MILESTONE_PLAN.length}`);
  const remaining = await chainService.getProjectEscrow(pid);
  info(`contract totalFunded for project: ${ethers.formatEther(remaining)}`);
  const contractBal = await provider.getBalance(chainCtx.contractAddress ?? process.env.CONTRACT_ADDRESS);
  check("contract holds no leftover escrow", contractBal === 0n, `${ethers.formatEther(contractBal)}`);

  const notifCount = await Notification.countDocuments({ projectId: project._id });
  info(`notifications emitted for this project: ${notifCount}`);

  // ---- summary ------------------------------------------------------------
  hr("RESULT");
  console.log(`  project      #${pid}  dbId=${project._id}`);
  console.log(`  milestones   ${MILESTONE_PLAN.length} (all released)`);
  console.log(`  deposits     ${MILESTONE_PLAN.length} x ${DEPOSIT_AMOUNT}`);
  console.log(`  final status ${projectAfter.status}`);
  console.log(`  chain        ${CHAIN_MODE}${CHAIN_MODE === "testnet" ? ` (real testnet BNB moved)` : " (throwaway chain, no real value)"}`);
  console.log(`  mongo        ${useScratchDb ? `${E2E_DB_NAME} (throwaway)` : "LIVE"}`);

  if (failures === 0) {
    console.log(`\n  ${C.green}${C.bold}ALL CHECKS PASSED${C.reset}\n`);
  } else {
    console.log(`\n  ${C.red}${C.bold}${failures} CHECK(S) FAILED${C.reset}\n`);
  }

  if (chainCtx.server) await chainCtx.server.close();
  await mongoose.disconnect();
  if (useScratchDb && !KEEP_DB) {
    const m2 = require("mongoose");
    await m2.connect(mongoUri);
    await m2.connection.dropDatabase();
    await m2.disconnect();
    info(`dropped scratch database ${E2E_DB_NAME}`);
  } else if (useScratchDb) {
    info(`kept scratch database ${E2E_DB_NAME}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`\n${C.red}${C.bold}E2E ABORTED${C.reset}`);
  console.error(err && err.stack ? err.stack : err);
  if (err && err.code) console.error(`code=${err.code}`);
  try {
    await mongoose_disconnect();
  } catch (_) {}
  process.exit(1);
});

async function mongoose_disconnect() {
  try {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  } catch (_) {}
}