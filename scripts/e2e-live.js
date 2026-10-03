/**
 * End-to-end escrow flow against the LIVE BNB Smart Chain Testnet deployment.
 *
 * Exercises the real contract with real value movement:
 *   createProject -> approveProject -> createMilestone -> depositFunds
 *   -> completeMilestone -> approveDeliverable -> claimMilestone
 *
 * It asserts escrow accounting, role enforcement, exact-amount deposits,
 * sequential claiming and the recipient's balance delta, so a regression cannot
 * silently pass.
 *
 * Required env (both accounts MUST hold BNB for gas on chain 97):
 *   E2E_CLIENT_PRIVATE_KEY   the client/buyer  (also the contract owner)
 *   E2E_FREELANCER_PRIVATE_KEY  the freelancer/seller
 *   CONTRACT_ADDRESS         optional, defaults to contracts/contractsData/Blockefy-address.json
 *   RPC_URL                  optional
 *
 * Usage: node scripts/e2e-live.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const artifact = JSON.parse(
  fs.readFileSync(path.join(ROOT, "contracts", "contractsData", "Blockefy.json"), "utf8")
);
const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS ||
  JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", "contractsData", "Blockefy-address.json"), "utf8")).address;
const RPC_URL = process.env.RPC_URL || "https://bsc-testnet.drpc.org";
const CHAIN_ID = Number(process.env.CHAIN_ID || 97);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const GAS = { gasLimit: 900000 };

async function expectRevert(promise, expected) {
  try {
    await promise;
    return { reverted: false, reason: null };
  } catch (e) {
    const msg = `${e.shortMessage || ""} ${e.reason || ""} ${e.message || ""}`;
    const m = msg.match(/reverted with reason string '([^']+)'/) || msg.match(/execution reverted: ["']([^"']+)["']/);
    const reason = m ? m[1] : msg;
    return { reverted: true, reason, matches: expected ? reason.includes(expected) : true };
  }
}

(async () => {
  console.log("=".repeat(72));
  console.log("Blockefy live E2E - BNB Smart Chain Testnet");
  console.log("=".repeat(72));
  console.log("rpc     :", RPC_URL);
  console.log("chainId :", CHAIN_ID);
  console.log("contract:", CONTRACT_ADDRESS);
  console.log();

  const clientKey = process.env.E2E_CLIENT_PRIVATE_KEY;
  const freelancerKey = process.env.E2E_FREELANCER_PRIVATE_KEY;

  if (!clientKey || !freelancerKey) {
    console.log("MISSING KEYS. Add these to .env and re-run:\n");
    console.log("  E2E_CLIENT_PRIVATE_KEY=0x...      # funded on BSC testnet");
    console.log("  E2E_FREELANCER_PRIVATE_KEY=0x...  # funded on BSC testnet\n");
    console.log("Get test BNB: https://www.bnbchain.org/en/testnetFaucet");
    process.exit(2);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const client = new ethers.Wallet(clientKey, provider);
  const freelancer = new ethers.Wallet(freelancerKey, provider);
  const outsider = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    provider
  );

  if (client.address === freelancer.address) {
    console.log("E2E_CLIENT_PRIVATE_KEY and E2E_FREELANCER_PRIVATE_KEY must be DIFFERENT accounts.");
    process.exit(2);
  }

  console.log("client     :", client.address);
  console.log("freelancer :", freelancer.address);
  console.log("outsider   :", outsider.address);
  console.log();

  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== CHAIN_ID) {
    console.log(`WRONG NETWORK: provider reports ${chainId}, expected ${CHAIN_ID}`);
    process.exit(2);
  }

  for (const [label, w] of [["client", client], ["freelancer", freelancer]]) {
    const bal = await provider.getBalance(w.address);
    console.log(`${label} balance: ${ethers.formatEther(bal)} BNB`);
    if (bal <= ethers.parseEther("0.002")) {
      console.log(`\n${label} (${w.address}) has ${ethers.formatEther(bal)} BNB - too little to send testnet transactions.`);
      console.log("Fund it from https://www.bnbchain.org/en/testnetFaucet then re-run.");
      process.exit(2);
    }
  }
  console.log();

  const code = await provider.getCode(CONTRACT_ADDRESS);
  check("contract deployed", code && code !== "0x", `${(code.length - 2) / 2} bytes`);
  if (!code || code === "0x") process.exit(1);

  const strip = (h) => {
    const b = (h || "0x").toLowerCase().replace(/^0x/, "");
    const m = parseInt(b.slice(-4), 16);
    if (!Number.isFinite(m) || m * 2 + 4 > b.length) return "0x" + b;
    return "0x" + b.slice(0, b.length - 4 - m * 2);
  };
  check(
    "deployed bytecode matches local artifact",
    ethers.keccak256(strip(code)) === ethers.keccak256(strip(artifact.deployedBytecode)),
    ethers.keccak256(strip(code)).slice(0, 12) + "..."
  );

  const asClient = new ethers.Contract(CONTRACT_ADDRESS, artifact.abi, client);
  const asFreelancer = new ethers.Contract(CONTRACT_ADDRESS, artifact.abi, freelancer);
  const asOutsider = new ethers.Contract(CONTRACT_ADDRESS, artifact.abi, outsider);

  const owner = await asClient.owner();
  console.log("\ncontract owner:", owner);
  console.log("client is owner:", owner.toLowerCase() === client.address.toLowerCase());
  console.log("treasury      :", await asClient.treasury());
  console.log("");

  // ---------------------------------------------------------------- project
  console.log("-".repeat(72));
  console.log("STEP 1  createProject  (client, Milestones)");
  console.log("-".repeat(72));

  const escrowedBefore = await asClient.totalEscrowed();
  const freelancerBefore = await provider.getBalance(freelancer.address);

  const receipt = await (
    await asClient.createProject(1, `e2e-${Date.now()}`, GAS)
  ).wait();
  const created = receipt.logs
    .map((l) => {
      try {
        return asClient.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "ProjectCreated");
  check("ProjectCreated event emitted", !!created);
  if (!created) {
    process.exit(1);
  }
  const projectId = created.args.projectId;
  console.log("  projectId:", projectId.toString());
  console.log("  gas used :", receipt.gasUsed.toString());

  let p = await asClient.projects(projectId);
  check("client recorded", p.client.toLowerCase() === client.address.toLowerCase());
  check("status = Created(0)", p.status === 0n, p.status.toString());
  check("deadline set", p.deadline > 0n);

  // -------------------------------------------------------------- milestones
  console.log("\n" + "-".repeat(72));
  console.log("STEP 2  createMilestone x2  (freelancer)");
  console.log("-".repeat(72));

  const AMT1 = ethers.parseEther("0.01");
  const AMT2 = ethers.parseEther("0.02");

  const desc = "x".repeat(500);
  const r1 = await (await asFreelancer.createMilestone(projectId, desc, AMT1, GAS)).wait();
  const ms1 = r1.logs
    .map((l) => {
      try {
        return asFreelancer.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "MilestoneCreated");
  check("milestone 1 created (500-byte description at the cap)", !!ms1);
  const m1 = ms1.args.milestoneId;
  console.log("  milestoneId 1:", m1.toString(), "gas:", r1.gasUsed.toString());

  const r2 = await (await asFreelancer.createMilestone(projectId, "second phase", AMT2, GAS)).wait();
  const ms2 = r2.logs
    .map((l) => {
      try {
        return asFreelancer.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "MilestoneCreated");
  const m2 = ms2.args.milestoneId;
  check("milestone 2 created", !!m2, m2.toString());

  const ids = await asClient.getProjectMilestones(projectId);
  check("milestone ids are ordered [1,2]", ids.length === 2 && ids[0] === m1 && ids[1] === m2, ids.join(","));

  console.log("\n  --- role + validation enforcement ---");
  check(
    "outsider cannot create a milestone",
    (await expectRevert(asOutsider.createMilestone.staticCall(projectId, "x", AMT1), "not the freelancer")).matches,
    "reverted"
  );
  check(
    "zero amount rejected",
    (await expectRevert(asFreelancer.createMilestone.staticCall(projectId, "x", 0n), "must be > 0")).matches
  );
  check(
    "empty description rejected",
    (await expectRevert(asFreelancer.createMilestone.staticCall(projectId, "", AMT1), "description required")).matches
  );
  const over = (await expectRevert(
    asFreelancer.createMilestone.staticCall(projectId, "x".repeat(501), AMT1),
    "description too long"
  )).matches;
  check("501-byte description rejected by the 500-byte cap", over);

  // ------------------------------------------------------------------ funding
  console.log("\n" + "-".repeat(72));
  console.log("STEP 3  approveProject + depositFunds  (client)");
  console.log("-".repeat(72));

  check(
    "outsider cannot approve a freelancer",
    (await expectRevert(asOutsider.approveProject.staticCall(projectId, outsider.address), "not the client")).matches
  );
  await (await asClient.approveProject(projectId, freelancer.address, GAS)).wait();
  p = await asClient.projects(projectId);
  check("freelancer assigned", p.freelancer.toLowerCase() === freelancer.address.toLowerCase());

  check(
    "wrong deposit amount rejected",
    (await expectRevert(asClient.depositFunds.staticCall(projectId, { value: AMT2 }), "must equal milestone amount")).matches
  );

  const d1 = await (await asClient.depositFunds(projectId, { ...GAS, value: AMT1 })).wait();
  check("deposit milestone 1", d1.status === 1, `gas ${d1.gasUsed}`);
  let st = await asClient.getProjectEscrow(projectId);
  check("project escrow = 0.01", st === AMT1, ethers.formatEther(st));
  check("totalEscrowed rose by 0.01", (await asClient.totalEscrowed()) === escrowedBefore + AMT1);
  check("contract holds 0.01 BNB", (await provider.getBalance(CONTRACT_ADDRESS)) >= AMT1);

  console.log("\n  --- escrow accounting invariants ---");
  check(
    "over-funding rejected (already funded)",
    (await expectRevert(asClient.depositFunds.staticCall(projectId, { value: AMT1 }), "must equal milestone amount")).matches
  );
  check(
    "freelancer cannot fund",
    (await expectRevert(asFreelancer.depositFunds.staticCall(projectId, { value: AMT1 }), "not the client")).matches
  );

  // ---------------------------------------------------------------- delivery
  console.log("\n" + "-".repeat(72));
  console.log("STEP 4  completeMilestone -> approveDeliverable -> claimMilestone");
  console.log("-".repeat(72));

  check(
    "cannot claim before submission",
    (await expectRevert(asFreelancer.claimMilestone.staticCall(projectId, m1), "not completed")).matches
  );
  check(
    "cannot approve before submission",
    (await expectRevert(asClient.approveDeliverable.staticCall(projectId, m1), "no submission to approve")).matches
  );

  await (await asFreelancer.completeMilestone(projectId, m1, GAS)).wait();
  const mm1 = await asClient.milestones(m1);
  check("milestone 1 submitted", mm1.isCompleted);
  check("review timer started", (await asClient.projects(projectId)).lastReviewAt > 0n);
  check("review window has NOT lapsed", (await asClient.isReviewLapsed(projectId)) === false);

  check(
    "strict sequencing: milestone 2 cannot be claimed yet",
    (await expectRevert(asFreelancer.claimMilestone.staticCall(projectId, m2), "not completed")).matches
  );

  await (await asClient.approveDeliverable(projectId, m1, GAS)).wait();
  mm1 = await asClient.milestones(m1);
  check("milestone 1 approved", mm1.isApproved);

  const escrowedPreClaim = await asClient.totalEscrowed();
  const claimTx = await (await asFreelancer.claimMilestone(projectId, m1, GAS)).wait();
  const claimed = claimTx.logs
    .map((l) => {
      try {
        return asFreelancer.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "MilestoneClaimed");
  check("MilestoneClaimed event emitted", !!claimed, claimed && claimed.args.amount.toString());

  const freelancerAfter = await provider.getBalance(freelancer.address);
  const delta = freelancerAfter - freelancerBefore;
  check(
    "freelancer received exactly 0.01 BNB (net of the gas it spent)",
    delta > 0n && delta <= AMT1,
    `delta ${ethers.formatEther(delta)} BNB`
  );

  check(
    "totalEscrowed released 0.01",
    (await asClient.totalEscrowed()) === escrowedPreClaim - AMT1,
    ethers.formatEther(await asClient.totalEscrowed())
  );
  st = await asClient.getProjectEscrow(projectId);
  check("project escrow back to 0", st === 0n);

  check(
    "double-claim rejected",
    (await expectRevert(asFreelancer.claimMilestone.staticCall(projectId, m1), "already claimed")).matches
  );

  // --------------------------------------------------------------- round two
  console.log("\n" + "-".repeat(72));
  console.log("STEP 5  milestone 2 (sequential) + review cycle");
  console.log("-".repeat(72));

  await (await asClient.depositFunds(projectId, { ...GAS, value: AMT2 })).wait();
  await (await asFreelancer.completeMilestone(projectId, m2, GAS)).wait();

  // requestChanges then resubmit: the rework path.
  const dlBefore = (await asClient.projects(projectId)).deadline;
  await (await asClient.requestChanges(projectId, m2, 5n, GAS)).wait();
  const afterChanges = await asClient.projects(projectId);
  check("requestChanges extended the deadline", afterChanges.deadline > dlBefore, `${dlBefore} -> ${afterChanges.deadline}`);
  check("milestone 2 re-opened for rework", (await asClient.milestones(m2)).isCompleted === false);

  check(
    "cannot claim a milestone in rework",
    (await expectRevert(asFreelancer.claimMilestone.staticCall(projectId, m2), "not completed")).matches
  );
  check(
    "deadline extension is bounded to 365 days",
    (await expectRevert(asClient.extendDeadline.staticCall(projectId, 366n), "extension too long")).matches
  );

  await (await asFreelancer.completeMilestone(projectId, m2, GAS)).wait();
  await (await asClient.approveDeliverable(projectId, m2, GAS)).wait();
  const fBefore2 = await provider.getBalance(freelancer.address);
  await (await asFreelancer.claimMilestone(projectId, m2, GAS)).wait();
  const fAfter2 = await provider.getBalance(freelancer.address);
  check("freelancer received milestone 2", fAfter2 > fBefore2, ethers.formatEther(fAfter2 - fBefore2));

  p = await asClient.projects(projectId);
  check("project status = Completed(3) once every milestone is released", p.status === 3n, p.status.toString());
  check("project escrow fully drained", (await asClient.getProjectEscrow(projectId)) === 0n);

  // ------------------------------------------------------- disputes & sweeps
  console.log("\n" + "-".repeat(72));
  console.log("STEP 6  reopen, dispute, owner-only sweep");
  console.log("-".repeat(72));

  const r3 = await (await asFreelancer.createMilestone(projectId, "reopened phase", ethers.parseEther("0.03"), GAS)).wait();
  const ms3 = r3.logs
    .map((l) => {
      try {
        return asFreelancer.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "MilestoneCreated");
  const m3 = ms3.args.milestoneId;
  check("adding a milestone re-opens a completed project", (await asClient.projects(projectId)).status === 2n, "InProgress");

  await (await asClient.depositFunds(projectId, { ...GAS, value: ethers.parseEther("0.03") })).wait();
  check("sweepSurplus is owner-only", (await expectRevert(asOutsider.sweepSurplus.staticCall(outsider.address), "Ownable")).matches);
  check(
    "sweepSurplus cannot touch escrow",
    (await expectRevert(asClient.sweepSurplus.staticCall(client.address), "no surplus to sweep")).matches
  );

  await (await asClient.openDispute(projectId, GAS)).wait();
  check("status = Disputed(5)", (await asClient.projects(projectId)).status === 5n);
  check(
    "payments locked while disputed",
    (await expectRevert(asFreelancer.claimMilestone.staticCall(projectId, m3), "disputed")).matches
  );
  check(
    "outsider cannot open a dispute",
    (await expectRevert(asOutsider.openDispute.staticCall(projectId), "not a party")).matches
  );

  if (client.address.toLowerCase() === owner.toLowerCase()) {
    const resolve = await (
      await asClient.resolveDispute(projectId, false, GAS)
    ).wait();
    const resolved = resolve.logs
      .map((l) => {
        try {
          return asClient.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l) => l && l.name === "DisputeResolved");
    check("owner resolved the dispute (refund to client)", !!resolved);
    check("status = Completed(3) after resolution", (await asClient.projects(projectId)).status === 3n);
    check("escrow released by the resolution", (await asClient.getProjectEscrow(projectId)) === 0n);
  } else {
    console.log("\n  SKIP  resolveDispute: the client is NOT the contract owner.");
    console.log("        owner is " + owner + "; add its key as E2E_CLIENT_PRIVATE_KEY to test this.");
  }

  // ------------------------------------------------------------------ report
  console.log("\n" + "=".repeat(72));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`RESULT: ${passed}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  }
  console.log("=".repeat(72));
  console.log("contract:", CONTRACT_ADDRESS);
  console.log("explorer: https://testnet.bscscan.com/address/" + CONTRACT_ADDRESS);
  console.log("totalEscrowed:", ethers.formatEther(await asClient.totalEscrowed()), "BNB");
  console.log("projectId used:", projectId.toString());
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("\nE2E FAILED:", e.shortMessage || e.message);
  if (e.receipt) console.error("tx hash:", e.receipt.hash);
  process.exit(1);
});