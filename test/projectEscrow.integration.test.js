/**
 * End-to-end project + escrow test (blockchain-backed).
 *
 * Requires a live hardhat node with the Blockefy contract deployed and a
 * dedicated test Mongo DB (separate URI so it can never collide with the order
 * flow integration test, which also wipes User/Transaction).
 *
 *   $env:TEST_PROJECT_MONGODB_URI="mongodb://127.0.0.1:27017/blockefy_test_projects"
 *   npm test   (or: node --test test/projectEscrow.integration.test.js)
 *
 * Skips cleanly when TEST_PROJECT_MONGODB_URI is not set.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { ethers } = require("ethers");

const URI = process.env.TEST_PROJECT_MONGODB_URI;
const skip = URI ? false : true;

const User = require("../src/models/User");
const Project = require("../src/models/Project");
const chainService = require("../src/services/chain.service");
const projectService = require("../src/services/project.service");
const proposalService = require("../src/services/proposal.service");
const milestoneService = require("../src/services/milestone.service");
const escrowService = require("../src/services/escrow.service");

// Standard hardhat deterministic accounts (all pre-funded with 10k ETH).
const BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SELLER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let buyer, seller, project, proposal, milestone;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    User.deleteMany({}),
    require("../src/models/Proposal").deleteMany({}),
    require("../src/models/Milestone").deleteMany({}),
    require("../src/models/Notification").deleteMany({}),
    Project.deleteMany({}),
  ]);
  const stamp = Date.now();

  buyer = await User.create({
    username: `pbuyer${stamp}`,
    email: `pbuyer${stamp}@test.com`,
    password: "testpass123",
    role: "buyer",
    isEmailVerified: true,
    walletPrivateKey: BUYER_KEY,
    walletAddress: new ethers.Wallet(BUYER_KEY).address,
  });
  seller = await User.create({
    username: `pseller${stamp}`,
    email: `pseller${stamp}@test.com`,
    password: "testpass123",
    role: "seller",
    isEmailVerified: true,
    walletPrivateKey: SELLER_KEY,
    walletAddress: new ethers.Wallet(SELLER_KEY).address,
  });
});

after(async () => {
  if (skip) return;
  await mongoose.connection.close();
});

test(
  "full project escrow flow: create → propose → accept → fund → deliver → release",
  { skip },
  async (t) => {
    if (!(await chainService.isChainAvailable())) {
      t.skip("Hardhat chain is not available; start node 1 and redeploy if needed");
      return;
    }

    // 1. Buyer publishes a project (pushed on-chain by relay).
    const created = await projectService.createProject({
      user: buyer,
      body: {
        title: "E2E escrow project",
        description: "Automated end-to-end escrow validation",
        category: "web-development",
        subcategory: "react",
        skills: ["react", "api"],
        experienceLevel: "intermediate",
        projectType: "fixed",
        budget: { min: 0.5, max: 2, currency: "ETH" },
        duration: "1 month",
        visibility: "public",
      },
    });
    project = created.project;
    assert.equal(project.status, "open");
    assert.ok(project.onChainProjectId, "project should exist on-chain");

    // 2. Seller sees the brief in the public browse endpoint.
    const browse = await projectService.listProjects({ user: seller, role: "public" });
    const inBrowse = browse.projects.some((p) => String(p._id) === String(project._id));
    assert.ok(inBrowse, "open public project must appear in the browse list");

    // 3. Seller applies and the buyer accepts.
    const applied = await proposalService.createProposal({
      user: seller,
      projectId: project._id,
      body: {
        coverLetter: "I can build this.",
        bidAmount: 1,
        estimatedDuration: "2 weeks",
        milestones: [{ title: "Milestone one", amount: 1 }],
        termsAccepted: true,
      },
    });
    proposal = applied.proposal;
    assert.equal(proposal.status, "submitted");

    const accepted = await proposalService.acceptProposal({ user: buyer, proposalId: proposal._id });
    project = accepted.project;
    assert.equal(project.status, "in_progress");
    assert.ok(String(project.hiredSellerId._id) === String(seller._id));

    // 4. Assigned freelancer creates the milestone plan before first deposit.
    const milestoneRes = await milestoneService.createMilestone({
      user: seller,
      projectId: project._id,
      body: { title: "Milestone one", description: "Phase 1 deliverable", amount: 1 },
    });
    milestone = milestoneRes.milestone;
    assert.equal(milestone.status, "pending");
    assert.ok(Number.isInteger(milestone.onChainMilestoneId) && milestone.onChainMilestoneId >= 0, "milestone should carry an on-chain id");

    // 5. Buyer funds escrow for the milestone (client-signed deposit).
    const deposit = await escrowService.createDeposit({
      project,
      user: buyer,
      milestoneId: milestone._id,
    });
    const wallet = new ethers.Wallet(BUYER_KEY, chainService.getProvider());
    const tx = await wallet.sendTransaction({
      to: deposit.payload.to,
      value: BigInt(deposit.payload.value),
      data: deposit.payload.data,
    });
    const receipt = await tx.wait();
    assert.equal(Number(receipt.status), 1, "deposit tx must succeed");

    const confirmed = await escrowService.confirmDeposit({
      project,
      user: buyer,
      milestoneId: milestone._id,
      txHash: tx.hash,
    });
    milestone = confirmed.milestone;
    assert.equal(milestone.paymentStatus, "paid");
    assert.equal(milestone.status, "funded");

    const chainBefore = await chainService.getProjectState(project.onChainProjectId);
    assert.equal(chainBefore.escrowEth, 1, "escrow should hold 1 ETH after deposit");

    // 6. Seller submits the work; chain flips to submitted.
    const submitted = await milestoneService.submitMilestone({
      milestoneId: milestone._id,
      user: seller,
      data: { url: "https://example.com/delivery", description: "Done." },
    });
    assert.equal(submitted.milestone.status, "submitted");
    const chainSubmitted = await chainService.getProjectState(project.onChainProjectId);
    assert.equal(chainSubmitted.isSubmitted, true);

    // 7. Buyer approves → escrow released to the freelancer, project completed.
    const released = await milestoneService.approveMilestone({
      milestoneId: milestone._id,
      user: buyer,
    });
    assert.equal(released.milestone.paymentStatus, "released");
    assert.equal(released.milestone.status, "completed");
    assert.equal(released.project.status, "completed");

    const chainAfter = await chainService.getProjectState(project.onChainProjectId);
    assert.equal(chainAfter.escrowEth, 0, "escrow empty after release");
    assert.equal(chainAfter.status, "completed");

    // 8. The completed project no longer appears as an open brief.
    const browseAfter = await projectService.listProjects({ user: seller, role: "public" });
    const stillOpen = browseAfter.projects.some((p) => String(p._id) === String(project._id));
    assert.ok(!stillOpen, "completed project must leave the open browse list");
  }
);

test(
  "public read: open+public brief is readable by non-participants, non-open stays restricted",
  { skip },
  async (t) => {
    if (!(await chainService.isChainAvailable())) {
      t.skip("Hardhat chain is not available");
      return;
    }

    const stamp = Date.now();
    const bystander = await User.create({
      username: `bypass${stamp}`,
      email: `bypass${stamp}@test.com`,
      password: "testpass123",
      role: "seller",
      isEmailVerified: true,
    });

    // Open + public brief → any authenticated user may read it.
    const created = await projectService.createProject({
      user: buyer,
      body: {
        title: "Public brief for bystanders",
        description: "Readable by any authenticated user while open",
        category: "design",
        projectType: "fixed",
        budget: { min: 0.1, max: 1, currency: "ETH" },
        visibility: "public",
      },
    });
    assert.equal(created.project.status, "open");

    const read = await projectService.getProject({
      user: bystander,
      projectId: created.project._id,
    });
    assert.equal(String(read.project._id), String(created.project._id), "non-participant can read an open+public brief");

    // Draft (non-open) remains participant-only, even if marked public.
    const draftOwner = await User.create({
      username: `draftown${stamp}`,
      email: `draftown${stamp}@test.com`,
      password: "testpass123",
      role: "buyer",
      isEmailVerified: true,
    });
    const draft = await projectService.createProject({
      user: draftOwner,
      body: {
        title: "Draft private brief",
        description: "Not visible while draft",
        category: "writing",
        budget: { min: 0.1, max: 0.5, currency: "ETH" },
        visibility: "public",
      },
    });
    assert.equal(draft.project.status, "draft");

    await assert.rejects(
      projectService.getProject({ user: bystander, projectId: draft.project._id }),
      (err) => err.statusCode === 403 && err.code === "FORBIDDEN",
      "draft (non-open) projects must stay participant-only"
    );
  }
);