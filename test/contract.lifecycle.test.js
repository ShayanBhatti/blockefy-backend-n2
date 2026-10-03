/**
 * End-to-end lifecycle + edge-case tests for contracts/Blockefy.sol.
 *
 * Runs the real compiled artifact against an in-process ganache EVM.
 * No database or backend is involved - this proves the contract logic itself.
 *
 * Revert expectations use ethers' `staticCall` (a plain eth_call) so the revert
 * reason is returned directly and msg.value is honoured. Note the v6 API shape
 * is `contract.method.staticCall(args)` - calling `contract.method(args)` first
 * would kick off a background gas estimate that rejects unhandled.
 *
 * Usage: node --test test/contract.lifecycle.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifact = require("../contracts/contractsData/Blockefy.json");

const ONE = (n) => ethers.parseEther(String(n));
// Balances include the gas the caller spent, so assert within a small tolerance.
const GAS_TOLERANCE = ethers.parseEther("0.01");

/**
 * ganache 7.9.2 returns the *minimum* gas limit for which a call succeeds, which
 * leaves no headroom and intermittently produces "out of gas" on real
 * transactions. Pad every estimate so the harness never depends on that
 * behaviour. This is a test-harness concern only - BSC estimates are correct.
 */
const GAS_ESTIMATE_MULTIPLIER = 2;
function withPaddedGasEstimates(eip1193) {
  const inner = eip1193.request.bind(eip1193);
  return {
    request: async (args) => {
      const result = await inner(args);
      if (args.method === "eth_estimateGas") {
        const block = await inner({ method: "eth_getBlockByNumber", params: ["latest", false] });
        const limit = block?.gasLimit ? BigInt(block.gasLimit) : 30_000_000n;
        const padded = BigInt(result) * BigInt(GAS_ESTIMATE_MULTIPLIER);
        return "0x" + (padded > limit ? limit : padded).toString(16);
      }
      return result;
    },
  };
}

/** Asserts that a contract call reverts and (when given) contains `substring`. */
async function expectRevert(promise, substring) {
  let msg = "";
  try {
    await promise;
  } catch (err) {
    msg = [
      err.shortMessage,
      err.reason,
      err.message,
      err.info?.error?.message,
      err.info?.error?.data?.reason,
    ]
      .filter(Boolean)
      .join(" ");
  }
  assert.ok(msg, `expected a revert containing "${substring}" but the call succeeded`);
  if (substring) {
    assert.ok(
      msg.includes(substring),
      `expected revert containing "${substring}" but got: ${msg.replace(/\n/g, " ").slice(0, 240)}`
    );
  }
}

let ctx;

test.before(async () => {
  const ganacheProvider = ganache.provider({
    wallet: { totalAccounts: 10, defaultBalance: 10000 },
    chain: { hardfork: "shanghai", chainId: 97, vmErrorsOnRPCResponse: true },
    logging: { quiet: true },
  });
  const eip1193 = withPaddedGasEstimates(ganacheProvider);
  const provider = new ethers.BrowserProvider(eip1193);
  const signers = [];
  for (let i = 0; i < 10; i++) signers.push(await provider.getSigner(i));
  const [owner, client, freelancer, outsider] = signers;

  // OpenZeppelin v5 raises custom errors (no reason strings); add them to the
  // interface so ethers can name them in assertions.
  const iface = new ethers.Interface([
    ...artifact.abi,
    "error OwnableUnauthorizedAccount(address account)",
    "error OwnableInvalidOwner(address owner)",
    "error EnforcedPause()",
    "error ExpectedPause()",
  ]);

  const factory = new ethers.ContractFactory(iface, artifact.bytecode, owner);
  const contract = await factory.deploy(await owner.getAddress());
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  ctx = {
    ganacheProvider, provider, owner, client, freelancer, outsider,
    contract, address, iface,
    asClient: contract.connect(client),
    asFreelancer: contract.connect(freelancer),
    asOutsider: contract.connect(outsider),
    asOwner: contract.connect(owner),
  };
});

test.after(async () => {
  if (ctx?.ganacheProvider) await ctx.ganacheProvider.disconnect();
});

const balanceOf = (addr) => ctx.provider.getBalance(addr);

async function timeTravel(seconds) {
  await ctx.ganacheProvider.request({ method: "evm_increaseTime", params: [seconds] });
  await ctx.ganacheProvider.request({ method: "evm_mine", params: [] });
}

/** Creates a project (real tx) and returns its on-chain id. */
async function createProject(type, metadata = "ipfs://brief") {
  const rc = await (await ctx.asClient.createProject(type, metadata)).wait();
  const ev = (await ctx.contract.queryFilter(ctx.contract.filters.ProjectCreated(), rc.blockNumber, rc.blockNumber))[0];
  return ev.args.projectId;
}

/** Creates a project and assigns the freelancer. */
async function newProject(type) {
  const id = await createProject(type);
  await (await ctx.asClient.approveProject(id, await ctx.freelancer.getAddress())).wait();
  return id;
}

const newMilestonesProject = () => newProject(1);
const newFixClaimProject = () => newProject(0);

async function addMilestone(projectId, amount, title) {
  const rc = await (await ctx.asFreelancer.createMilestone(projectId, title, ONE(amount))).wait();
  const ev = (await ctx.contract.queryFilter(ctx.contract.filters.MilestoneCreated(), rc.blockNumber, rc.blockNumber))[0];
  return ev.args.milestoneId;
}

// --- state-changing helpers -------------------------------------------------
const deposit = (id, amount) => ctx.asClient.depositFunds(id, { value: ONE(amount) });
const complete = (id, m) => ctx.asFreelancer.completeMilestone(id, m);
const approve = (id, m) => ctx.asClient.approveDeliverable(id, m);
const claim = (id, m) => ctx.asFreelancer.claimMilestone(id, m);
const requestChanges = (id, m, days) => ctx.asClient.requestChanges(id, m, days);

// --- read-only (eth_call) helpers, used to assert reverts --------------------
const sDeposit = (id, amount) => ctx.asClient.depositFunds.staticCall(id, { value: ONE(amount) });
const sComplete = (id, m) => ctx.asFreelancer.completeMilestone.staticCall(id, m);
const sApprove = (id, m) => ctx.asClient.approveDeliverable.staticCall(id, m);
const sClaim = (id, m) => ctx.asFreelancer.claimMilestone.staticCall(id, m);
const sRequestChanges = (id, m, days) => ctx.asClient.requestChanges.staticCall(id, m, days);
const sExtendDeadline = (id, days) => ctx.asClient.extendDeadline.staticCall(id, days);
const sRetrieveFunds = (id) => ctx.asClient.retrieveFunds.staticCall(id);

// ---------------------------------------------------------------------------
// Deployment & project creation
// ---------------------------------------------------------------------------
test("deploys with a treasury, zero fee and sane defaults", async () => {
  assert.equal(await ctx.contract.platformFeeBps(), 0n);
  assert.equal(await ctx.contract.treasury(), await ctx.owner.getAddress());
  assert.equal(await ctx.contract.DEFAULT_REVIEW_WINDOW(), 15n * 24n * 60n * 60n);
  assert.equal(await ctx.contract.MAX_REVISIONS(), 10n);
});

test("createProject sets a real deadline so refunds are reachable", async () => {
  const id = await newMilestonesProject();
  const p = await ctx.contract.projects(id);
  assert.equal(p.status, 0n, "Created");
  assert.ok(p.deadline > 0n, "deadline must be initialised, not 0");
  assert.equal(p.totalFunded, 0n);
  assert.equal(p.reviewWindow, 15n * 24n * 60n * 60n);
});

test("only the client can assign a freelancer, and only once", async () => {
  const f = await ctx.freelancer.getAddress();
  const id = await createProject(1);

  await expectRevert(ctx.asFreelancer.approveProject.staticCall(id, f), "not the client");
  await expectRevert(ctx.asOutsider.approveProject.staticCall(id, f), "not the client");

  await (await ctx.asClient.approveProject(id, f)).wait();
  await expectRevert(ctx.asClient.approveProject.staticCall(id, f), "already has a freelancer");
});

test("client cannot assign itself, and the zero address is rejected", async () => {
  const id = await createProject(1);
  await expectRevert(
    ctx.asClient.approveProject.staticCall(id, await ctx.client.getAddress()),
    "invalid freelancer"
  );
  await expectRevert(ctx.asClient.approveProject.staticCall(id, ethers.ZeroAddress), "invalid freelancer");
});

test("strangers and the wrong role cannot touch a project", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await expectRevert(ctx.asOutsider.createMilestone.staticCall(id, "hack", ONE(1)), "not the freelancer");
  await expectRevert(ctx.asClient.createMilestone.staticCall(id, "hack", ONE(1)), "not the freelancer");
  await expectRevert(ctx.asFreelancer.depositFunds.staticCall(id, { value: ONE(1) }), "not the client");
  await expectRevert(ctx.asOutsider.openDispute.staticCall(id), "not a party");
  await expectRevert(ctx.asFreelancer.retrieveFunds.staticCall(id), "not the client");
});

// ---------------------------------------------------------------------------
// Milestone creation (fix: add milestones at any time)
// ---------------------------------------------------------------------------
test("milestones can be added after funding and after completion (reopen)", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "phase 1");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await (await claim(id, m1)).wait();
  assert.equal((await ctx.contract.projects(id)).status, 3n, "Completed");

  const m2 = await addMilestone(id, 2, "phase 2 after completion");
  assert.equal((await ctx.contract.projects(id)).status, 2n, "re-opened to InProgress");
  assert.ok(m2 > m1);
});

test("milestone requires a positive amount and a description", async () => {
  const id = await newMilestonesProject();
  await expectRevert(ctx.asFreelancer.createMilestone.staticCall(id, "zero", 0), "must be > 0");
  await expectRevert(ctx.asFreelancer.createMilestone.staticCall(id, "", ONE(1)), "description required");
});

test("milestone description is capped so the relay can never run out of gas", async () => {
  const id = await newMilestonesProject();
  const max = Number(await ctx.contract.MAX_DESCRIPTION_LENGTH());
  assert.equal(max, 500);
  const atLimit = "x".repeat(max);
  const overLimit = "x".repeat(max + 1);
  await expectRevert(ctx.asFreelancer.createMilestone.staticCall(id, overLimit, ONE(1)), "description too long");
  // Exactly at the limit must still work (and stay within the backend gas limit).
  const m = await addMilestone(id, 1, atLimit);
  assert.ok(m > 0);
});

test("milestones cannot be added to a FixClaim project", async () => {
  const id = await newFixClaimProject();
  await expectRevert(ctx.asFreelancer.createMilestone.staticCall(id, "nope", ONE(1)), "not a milestones project");
});

// ---------------------------------------------------------------------------
// Deposits: ordered, exact, no over-funding
// ---------------------------------------------------------------------------
test("deposits must exactly match the next unfunded milestone", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await expectRevert(sDeposit(id, 0.5), "must equal milestone amount");
  await expectRevert(sDeposit(id, 2), "must equal milestone amount");
  await (await deposit(id, 1)).wait();
  const p = await ctx.contract.projects(id);
  assert.equal(p.totalFunded, ONE(1));
  assert.equal(p.status, 1n, "Funded");
});

test("deposits are strictly ordered - only the next unfunded milestone", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  const m2 = await addMilestone(id, 2, "b");

  // Paying m2's amount is rejected because m1 is the next unfunded milestone.
  await expectRevert(sDeposit(id, 2), "must equal milestone amount");
  await (await deposit(id, 1)).wait();
  assert.equal((await ctx.contract.milestones(m1)).isFunded, true);
  assert.equal((await ctx.contract.milestones(m2)).isFunded, false);
});

test("cannot fund anything once every milestone is funded", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "only");
  await (await deposit(id, 1)).wait();
  await expectRevert(sDeposit(id, 1), "no milestone awaiting funding");
});

test("cannot complete or approve an unfunded milestone", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await expectRevert(sComplete(id, m1), "not funded");
  await expectRevert(sApprove(id, m1), "no submission to approve");
});

test("cannot submit the same milestone twice", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await expectRevert(sComplete(id, m1), "already submitted");
});

// ---------------------------------------------------------------------------
// Review + claim (fix: per-milestone approval)
// ---------------------------------------------------------------------------
test("claiming requires approval, and approval releases only that milestone", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  const m2 = await addMilestone(id, 2, "b");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();

  await expectRevert(sClaim(id, m1), "not approved yet");

  await (await approve(id, m1)).wait();
  await (await claim(id, m1)).wait();
  assert.equal((await ctx.contract.milestones(m1)).isClaimed, true);
  assert.equal((await ctx.contract.projects(id)).totalFunded, 0n);

  // KEY REGRESSION: approving m1 must not unlock m2.
  await (await deposit(id, 2)).wait();
  await (await complete(id, m2)).wait();
  await expectRevert(sClaim(id, m2), "not approved yet");
  await (await approve(id, m2)).wait();
  await (await claim(id, m2)).wait();
  assert.equal((await ctx.contract.milestones(m2)).isClaimed, true);
  assert.equal((await ctx.contract.projects(id)).status, 3n, "Completed");
});

test("only the client can approve", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await expectRevert(ctx.asFreelancer.approveDeliverable.staticCall(id, m1), "not the client");
  await expectRevert(ctx.asOutsider.approveDeliverable.staticCall(id, m1), "not the client");
  await expectRevert(sApprove(id, 999999n), "not in project");
});

test("sequential claiming: milestone 2 cannot be claimed before 1", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  const m2 = await addMilestone(id, 2, "b");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await (await deposit(id, 2)).wait();
  await (await complete(id, m2)).wait();
  await (await approve(id, m2)).wait();

  await expectRevert(sClaim(id, m2), "previous milestone not claimed");
  await (await claim(id, m1)).wait();
  await (await claim(id, m2)).wait();
});

test("double-claim is impossible and escrow accounting returns to zero", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  const escrowBefore = await ctx.contract.totalEscrowed();
  await (await deposit(id, 1)).wait();
  assert.equal(await ctx.contract.totalEscrowed(), escrowBefore + ONE(1));
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await (await claim(id, m1)).wait();
  await expectRevert(sClaim(id, m1), "already claimed");
  assert.equal((await ctx.contract.projects(id)).totalFunded, 0n);
  assert.equal(await ctx.contract.totalEscrowed(), escrowBefore, "global escrow back to baseline");
});

test("payout transfers ETH to the freelancer (net of gas)", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "pay me");
  const fAddr = await ctx.freelancer.getAddress();
  const before = await balanceOf(fAddr);
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await (await claim(id, m1)).wait();
  const delta = (await balanceOf(fAddr)) - before;
  assert.ok(delta > ONE(1) - GAS_TOLERANCE && delta <= ONE(1), `freelancer got ${ethers.formatEther(delta)} BNB`);
});

test("only a party can claim a milestone", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await expectRevert(ctx.asOutsider.claimMilestone.staticCall(id, m1), "unauthorized");
});

// ---------------------------------------------------------------------------
// Revisions (fix: resubmission is possible)
// ---------------------------------------------------------------------------
test("requestChanges re-opens the milestone so it can be resubmitted", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();

  await (await requestChanges(id, m1, 3)).wait();
  const m = await ctx.contract.milestones(m1);
  assert.equal(m.isCompleted, false, "re-opened for rework");
  assert.equal(m.isApproved, false);
  assert.equal((await ctx.contract.projects(id)).changesCount, 1n);

  // Cannot claim while re-opened.
  await expectRevert(sClaim(id, m1), "not completed");

  // Resubmit -> approve -> claim.
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await (await claim(id, m1)).wait();
  assert.equal((await ctx.contract.milestones(m1)).isClaimed, true);
});

test("only the client can request changes, and extra days must be > 0", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  const m2 = await addMilestone(id, 1, "b");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await expectRevert(ctx.asFreelancer.requestChanges.staticCall(id, m1, 3), "not the client");
  await expectRevert(sRequestChanges(id, m1, 0), "extra days must be > 0");
  // m2 is funded but never delivered, so there is nothing to send back.
  await expectRevert(sRequestChanges(id, m2, 3), "no submission to review");
  await expectRevert(sRequestChanges(id, 999999n, 3), "not in project");
});

test("revisions are capped at MAX_REVISIONS", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  for (let i = 0; i < 10; i++) {
    await (await complete(id, m1)).wait();
    await (await requestChanges(id, m1, 1)).wait();
  }
  await (await complete(id, m1)).wait();
  await expectRevert(sRequestChanges(id, m1, 1), "revision limit reached");
  assert.equal((await ctx.contract.projects(id)).changesCount, 10n);
});

test("requestChanges only ever extends the deadline", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  const before = (await ctx.contract.projects(id)).deadline;
  await (await requestChanges(id, m1, 5)).wait();
  const after = (await ctx.contract.projects(id)).deadline;
  assert.ok(after > before, `deadline must grow: ${before} -> ${after}`);
  assert.ok(after - before <= 6n * 24n * 60n * 60n, "extension must not be absurd");
});

test("extendDeadline only ever extends the deadline", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  const before = (await ctx.contract.projects(id)).deadline;
  await (await ctx.asClient.extendDeadline(id, 7)).wait();
  const after = (await ctx.contract.projects(id)).deadline;
  assert.ok(after > before, `deadline must grow: ${before} -> ${after}`);
  await expectRevert(ctx.asFreelancer.extendDeadline.staticCall(id, 7), "not the client");
  await expectRevert(sExtendDeadline(id, 0), "extra days must be > 0");
});

test("a single deadline extension is bounded but still additive", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  const max = Number(await ctx.contract.MAX_DEADLINE_EXTENSION());
  assert.equal(max, 365, "a single extension is capped at 365 days");

  // An unbounded value would overflow `base + extraDays * 1 days` and revert in a
  // way the caller could never recover from, so it is rejected up front.
  await expectRevert(sExtendDeadline(id, 0), "extra days must be > 0");
  await expectRevert(ctx.asClient.extendDeadline.staticCall(id, max + 1), "extension too long");
  await expectRevert(
    ctx.asClient.extendDeadline.staticCall(id, ethers.MaxUint256),
    "extension too long"
  );

  // At the cap it still works, and repeated calls can extend arbitrarily far.
  const before = (await ctx.contract.projects(id)).deadline;
  await (await ctx.asClient.extendDeadline(id, max)).wait();
  const once = (await ctx.contract.projects(id)).deadline;
  assert.ok(once > before, "a capped extension must still extend the deadline");
  await (await ctx.asClient.extendDeadline(id, max)).wait();
  const twice = (await ctx.contract.projects(id)).deadline;
  assert.ok(twice > once, "extensions must remain additive across calls");
  assert.ok(
    twice - once <= max * 86400 + 5,
    `one extension may add at most ${max} days (${max * 86400}s), got ${twice - once}`
  );
});

// ---------------------------------------------------------------------------
// Auto-release safeguard
// ---------------------------------------------------------------------------
test("un-reviewed work auto-releases after the review window", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 0.5, "a");
  const fAddr = await ctx.freelancer.getAddress();
  const before = await balanceOf(fAddr);
  await (await deposit(id, 0.5)).wait();
  await (await complete(id, m1)).wait();
  assert.equal(await ctx.contract.isReviewLapsed(id), false);
  await timeTravel(15 * 24 * 60 * 60 + 60);
  assert.equal(await ctx.contract.isReviewLapsed(id), true);
  await (await claim(id, m1)).wait();
  const delta = (await balanceOf(fAddr)) - before;
  assert.ok(delta > ONE(0.5) - GAS_TOLERANCE && delta <= ONE(0.5), `auto-released ${ethers.formatEther(delta)} BNB`);
});

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------
test("refund is blocked before the deadline and after completion", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await expectRevert(sRetrieveFunds(id), "deadline not passed");

  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await (await claim(id, m1)).wait();

  await timeTravel(40 * 24 * 60 * 60);
  await expectRevert(sRetrieveFunds(id), "already completed");
});

test("refund protects a deliverable that is under review", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await timeTravel(40 * 24 * 60 * 60);
  await expectRevert(sRetrieveFunds(id), "under review");
});

test("refund returns escrow to the client after the deadline", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await addMilestone(id, 2, "b");
  const cAddr = await ctx.client.getAddress();
  await (await deposit(id, 1)).wait();
  await (await deposit(id, 2)).wait();
  // Snapshot AFTER the deposits, so the delta isolates the refund.
  const before = await balanceOf(cAddr);

  await timeTravel(40 * 24 * 60 * 60);
  await (await ctx.asClient.retrieveFunds(id)).wait();

  const p = await ctx.contract.projects(id);
  assert.equal(p.status, 4n, "Cancelled");
  assert.equal(p.totalFunded, 0n);
  const delta = (await balanceOf(cAddr)) - before;
  assert.ok(delta > ONE(3) - GAS_TOLERANCE, `client got ${ethers.formatEther(delta)} BNB back`);
});

test("refund is client-only", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await timeTravel(40 * 24 * 60 * 60);
  await expectRevert(ctx.asFreelancer.retrieveFunds.staticCall(id), "not the client");
  await expectRevert(ctx.asOutsider.retrieveFunds.staticCall(id), "not the client");
});

test("a cancelled project cannot be used again", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await timeTravel(40 * 24 * 60 * 60);
  await (await ctx.asClient.retrieveFunds(id)).wait();
  await expectRevert(sDeposit(id, 1), "cancelled");
  await expectRevert(ctx.asFreelancer.createMilestone.staticCall(id, "more", ONE(1)), "cancelled");
});

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------
test("the freelancer can open a dispute; it freezes payouts", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();

  await (await ctx.asFreelancer.openDispute(id)).wait();
  const p = await ctx.contract.projects(id);
  assert.equal(p.status, 5n, "Disputed");
  assert.equal((await ctx.contract.milestones(m1)).isDisputed, true);
  await expectRevert(sClaim(id, m1), "under dispute");
  await expectRevert(sDeposit(id, 1), "under dispute");
  await expectRevert(sComplete(id, m1), "under dispute");
});

test("the client can open a dispute, and it cannot be double-opened", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await (await ctx.asClient.openDispute(id)).wait();
  await expectRevert(ctx.asClient.openDispute.staticCall(id), "already disputed");
  await expectRevert(ctx.asFreelancer.openDispute.staticCall(id), "already disputed");
});

test("the admin can open a dispute too (participant-or-owner)", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await (await ctx.asOwner.openDispute(id)).wait();
  assert.equal((await ctx.contract.projects(id)).status, 5n);
});

test("a completed project cannot be disputed", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await (await claim(id, m1)).wait();
  await expectRevert(ctx.asClient.openDispute.staticCall(id), "already completed");
});

test("only the admin resolves a dispute, paying the freelancer", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await (await ctx.asClient.openDispute(id)).wait();

  await expectRevert(ctx.asClient.resolveDispute.staticCall(id, true), "OwnableUnauthorizedAccount");
  await expectRevert(ctx.asFreelancer.resolveDispute.staticCall(id, true), "OwnableUnauthorizedAccount");

  const fAddr = await ctx.freelancer.getAddress();
  const before = await balanceOf(fAddr);
  await (await ctx.asOwner.resolveDispute(id, true)).wait();
  const delta = (await balanceOf(fAddr)) - before;
  assert.ok(delta > ONE(1) - GAS_TOLERANCE && delta <= ONE(1), `freelancer got ${ethers.formatEther(delta)} BNB`);
  const p = await ctx.contract.projects(id);
  assert.equal(p.status, 3n, "Completed after resolution");
  assert.equal(p.totalFunded, 0n);
  const ids = await ctx.contract.getProjectMilestones(id);
  assert.equal((await ctx.contract.milestones(ids[0])).isDisputed, false, "dispute flags cleared");
});

test("dispute resolution can refund the client instead", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  const cAddr = await ctx.client.getAddress();
  await (await deposit(id, 1)).wait();
  const before = await balanceOf(cAddr);
  await (await ctx.asClient.openDispute(id)).wait();
  await (await ctx.asOwner.resolveDispute(id, false)).wait();
  const delta = (await balanceOf(cAddr)) - before;
  assert.ok(delta > ONE(1) - GAS_TOLERANCE, `client refunded ${ethers.formatEther(delta)} BNB`);
});

test("dispute resolution applies the platform fee", async () => {
  await (await ctx.asOwner.setPlatformFee(500)).wait(); // 5%
  const id = await newMilestonesProject();
  await addMilestone(id, 10, "fee");
  await (await deposit(id, 10)).wait();
  await (await ctx.asClient.openDispute(id)).wait();
  const fAddr = await ctx.freelancer.getAddress();
  const tAddr = await ctx.owner.getAddress();
  const fBefore = await balanceOf(fAddr);
  const tBefore = await balanceOf(tAddr);
  await (await ctx.asOwner.resolveDispute(id, true)).wait();
  const fDelta = (await balanceOf(fAddr)) - fBefore;
  const tDelta = (await balanceOf(tAddr)) - tBefore;
  assert.ok(fDelta > ONE(9.5) - GAS_TOLERANCE && fDelta <= ONE(9.5), `freelancer got 95%: ${ethers.formatEther(fDelta)}`);
  // The owner/treasury also signs this tx, so the fee arrives net of its gas.
  assert.ok(
    tDelta > ONE(0.5) - GAS_TOLERANCE && tDelta <= ONE(0.5),
    `treasury got 5% even on a dispute payout: ${ethers.formatEther(tDelta)}`
  );
  await (await ctx.asOwner.setPlatformFee(0)).wait();
});

test("a project must actually be disputed to be resolved", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await expectRevert(ctx.asOwner.resolveDispute.staticCall(id, true), "not disputed");
});

// ---------------------------------------------------------------------------
// FixClaim (previously unreachable)
// ---------------------------------------------------------------------------
test("FixClaim full lifecycle is reachable end-to-end", async () => {
  const id = await newFixClaimProject();
  await (await deposit(id, 3)).wait();
  assert.equal((await ctx.contract.projects(id)).status, 1n, "Funded");
  assert.equal((await ctx.contract.projects(id)).fixClaimAmount, ONE(3));

  await expectRevert(ctx.asFreelancer.fixClaim.staticCall(id), "deliverable not approved");
  await (await ctx.asFreelancer.submitFixClaim(id)).wait();
  await expectRevert(ctx.asFreelancer.submitFixClaim.staticCall(id), "already submitted");
  await (await ctx.asClient.approveFixClaim(id)).wait();

  const fAddr = await ctx.freelancer.getAddress();
  const before = await balanceOf(fAddr);
  await (await ctx.asFreelancer.fixClaim(id)).wait();
  const delta = (await balanceOf(fAddr)) - before;
  assert.ok(delta > ONE(3) - GAS_TOLERANCE && delta <= ONE(3), `freelancer got ${ethers.formatEther(delta)} BNB`);
  const p = await ctx.contract.projects(id);
  assert.equal(p.status, 3n, "Completed");
  assert.equal(p.totalFunded, 0n);
});

test("FixClaim guards: wrong type, double funding, approval roles", async () => {
  const milestonesProject = await newMilestonesProject();
  await expectRevert(ctx.asFreelancer.submitFixClaim.staticCall(milestonesProject), "not a fix claim project");
  await expectRevert(ctx.asClient.approveFixClaim.staticCall(milestonesProject), "not a fix claim project");

  const id = await newFixClaimProject();
  await (await deposit(id, 1)).wait();
  await expectRevert(sDeposit(id, 1), "already funded");
  await (await ctx.asFreelancer.submitFixClaim(id)).wait();
  await expectRevert(ctx.asFreelancer.approveFixClaim.staticCall(id), "not the client");
  await expectRevert(ctx.asOutsider.fixClaim.staticCall(id), "unauthorized");
  await expectRevert(ctx.asOutsider.approveFixClaim.staticCall(id), "not the client");
});

test("FixClaim auto-releases if the client never reviews", async () => {
  const id = await newFixClaimProject();
  await (await deposit(id, 1)).wait();
  await (await ctx.asFreelancer.submitFixClaim(id)).wait();
  await timeTravel(15 * 24 * 60 * 60 + 60);
  const fAddr = await ctx.freelancer.getAddress();
  const before = await balanceOf(fAddr);
  await (await ctx.asFreelancer.fixClaim(id)).wait();
  const delta = (await balanceOf(fAddr)) - before;
  assert.ok(delta > ONE(1) - GAS_TOLERANCE, `auto-released ${ethers.formatEther(delta)} BNB`);
});

// ---------------------------------------------------------------------------
// Surplus / stray ETH recovery (previously impossible)
// ---------------------------------------------------------------------------
test("stray ETH can be swept but escrow can never be swept", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  const escrowBefore = await ctx.contract.totalEscrowed();
  await (await deposit(id, 1)).wait();

  await ctx.client.sendTransaction({ to: ctx.address, value: ONE(0.25) });
  const bal = await ctx.provider.getBalance(ctx.address);
  assert.ok(bal > (await ctx.contract.totalEscrowed()), "surplus exists");

  const treasuryAddr = await ctx.owner.getAddress();
  const before = await balanceOf(treasuryAddr);
  await (await ctx.asOwner.sweepSurplus(treasuryAddr)).wait();
  assert.ok((await balanceOf(treasuryAddr)) > before, "surplus swept");

  // Escrow fully intact after the sweep.
  assert.equal((await ctx.contract.projects(id)).totalFunded, ONE(1));
  assert.equal(await ctx.contract.totalEscrowed(), escrowBefore + ONE(1));

  await expectRevert(ctx.asOutsider.sweepSurplus.staticCall(treasuryAddr), "OwnableUnauthorizedAccount");
  await expectRevert(ctx.asOwner.sweepSurplus.staticCall(ethers.ZeroAddress), "invalid recipient");
});

test("sweep cannot drain escrow when there is no surplus", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await (await deposit(id, 1)).wait();
  await expectRevert(ctx.asOwner.sweepSurplus.staticCall(await ctx.owner.getAddress()), "no surplus to sweep");
});

// ---------------------------------------------------------------------------
// Admin controls
// ---------------------------------------------------------------------------
test("pause blocks funding and milestone work; owner can unpause", async () => {
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 1, "a");
  await (await ctx.asOwner.pause()).wait();
  try {
    await expectRevert(sDeposit(id, 1), "EnforcedPause");
    await expectRevert(ctx.asFreelancer.createMilestone.staticCall(id, "x", ONE(1)), "EnforcedPause");
    await expectRevert(sComplete(id, m1), "EnforcedPause");
    await expectRevert(ctx.asClient.createProject.staticCall(1, "ipfs://x"), "EnforcedPause");
  } finally {
    await (await ctx.asOwner.unpause()).wait();
  }
  await (await deposit(id, 1)).wait();
  await expectRevert(ctx.asClient.pause.staticCall(), "OwnableUnauthorizedAccount");
  await expectRevert(ctx.asOutsider.unpause.staticCall(), "OwnableUnauthorizedAccount");
});

test("fee is capped at 10% and applied to milestone payouts", async () => {
  await expectRevert(ctx.asOwner.setPlatformFee.staticCall(2000), "fee too high");
  await expectRevert(ctx.asClient.setPlatformFee.staticCall(100), "OwnableUnauthorizedAccount");
  await (await ctx.asOwner.setPlatformFee(200)).wait(); // 2%
  const id = await newMilestonesProject();
  const m1 = await addMilestone(id, 10, "fee test");
  const fAddr = await ctx.freelancer.getAddress();
  const tAddr = await ctx.owner.getAddress();
  const fBefore = await balanceOf(fAddr);
  const tBefore = await balanceOf(tAddr);
  await (await deposit(id, 10)).wait();
  await (await complete(id, m1)).wait();
  await (await approve(id, m1)).wait();
  await (await claim(id, m1)).wait();
  const fDelta = (await balanceOf(fAddr)) - fBefore;
  const tDelta = (await balanceOf(tAddr)) - tBefore;
  assert.ok(fDelta > ONE(9.8) - GAS_TOLERANCE && fDelta <= ONE(9.8), `98%: ${ethers.formatEther(fDelta)}`);
  assert.equal(tDelta, ONE(0.2), "treasury got 2%");
  await (await ctx.asOwner.setPlatformFee(0)).wait();
});

test("treasury cannot be set to the zero address", async () => {
  await expectRevert(ctx.asOwner.setTreasury.staticCall(ethers.ZeroAddress), "invalid treasury");
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
test("view helpers return consistent data", async () => {
  const id = await newMilestonesProject();
  await addMilestone(id, 1, "a");
  await addMilestone(id, 2, "b");
  const ids = await ctx.contract.getProjectMilestones(id);
  assert.equal(ids.length, 2);
  const details = await ctx.contract.getMilestonesDetails(id);
  assert.equal(details.length, 2);
  assert.equal(details[0].amount, ONE(1));
  assert.equal(details[1].amount, ONE(2));
  assert.equal(await ctx.contract.getProjectEscrow(id), 0n);
  assert.equal((await ctx.contract.projectCounter()) > 0n, true);
});

test("unknown project ids are rejected", async () => {
  await expectRevert(sDeposit(999999n, 1), "does not exist");
  await expectRevert(ctx.contract.getProjectEscrow.staticCall(0), "does not exist");
});
