/**
 * Measures real gas usage of every relayed contract method against a fresh
 * ganache deployment, so the backend's hardcoded `gasLimit` can be validated
 * instead of guessed.
 *
 * Usage: node scripts/measure-gas.js
 */
const ganache = require("ganache");
const { ethers } = require("ethers");
const artifact = require("../contracts/contractsData/Blockefy.json");

const ONE = (n) => ethers.parseEther(String(n));

/**
 * ganache 7.9.2 returns the *minimum* gas limit a call succeeds with, which
 * intermittently under-estimates real usage. Pad so measurements reflect actual
 * gas consumption rather than ganache's search result.
 */
const withPaddedGasEstimates = (eip1193) => {
  const inner = eip1193.request.bind(eip1193);
  return {
    request: async (args) => {
      const result = await inner(args);
      if (args.method !== "eth_estimateGas") return result;
      const block = await inner({ method: "eth_getBlockByNumber", params: ["latest", false] });
      const limit = block?.gasLimit ? BigInt(block.gasLimit) : 30_000_000n;
      const padded = BigInt(result) * 2n;
      return "0x" + (padded > limit ? limit : padded).toString(16);
    },
  };
};

const main = async () => {
  const ganacheProvider = ganache.provider({
    wallet: { totalAccounts: 6, defaultBalance: 10000 },
    chain: { hardfork: "shanghai", chainId: 97, vmErrorsOnRPCResponse: true },
    logging: { quiet: true },
  });
  const eip1193 = withPaddedGasEstimates(ganacheProvider);
  const provider = new ethers.BrowserProvider(eip1193);
  const [owner, client, freelancer] = await Promise.all([
    provider.getSigner(0), provider.getSigner(1), provider.getSigner(2),
  ]);

  const contract = await (await new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner))
    .deploy(await owner.getAddress());
  await contract.waitForDeployment();
  const asClient = contract.connect(client);
  const asFreelancer = contract.connect(freelancer);

  const rows = [];
  const estimates = [];
  const measure = async (label, run) => {
    const tx = await run();
    const receipt = await tx.wait();
    rows.push({ label, gas: receipt.gasUsed.toString() });
  };
  const readGas = async (label, fn) => {
    const g = await fn();
    estimates.push({ label, gas: g.toString() });
  };

  const freelancerAddress = await freelancer.getAddress();
  const ownerAddress = await owner.getAddress();

  // Build a live project with several milestones.
  const rc = await (await asClient.createProject(1, "ipfs://brief")).wait();
  const pid = (await contract.queryFilter(contract.filters.ProjectCreated(), rc.blockNumber, rc.blockNumber))[0].args.projectId;
  await measure("createProject", () => asClient.createProject(1, "ipfs://brief"));
  await measure("approveProject", () => asClient.approveProject(pid, freelancerAddress));

  // The contract caps descriptions at MAX_DESCRIPTION_LENGTH (500), so a
  // full-length description is the real worst case the backend must relay.
  const maxDescription = "Phase ".padEnd(500, "x").slice(0, 500);
  const mc = await (await asFreelancer.createMilestone(pid, maxDescription, ONE(1))).wait();
  const ms = (await contract.queryFilter(contract.filters.MilestoneCreated(), mc.blockNumber, mc.blockNumber))[0].args.milestoneId;
  await measure(`createMilestone (${maxDescription.length}-byte desc = max)`, () => asFreelancer.createMilestone(pid, maxDescription, ONE(1)));
  await measure("createMilestone (short desc)", () => asFreelancer.createMilestone(pid, "phase 1", ONE(1)));
  await measure("depositFunds", () => asClient.depositFunds(pid, { value: ONE(1) }));
  await measure("completeMilestone", () => asFreelancer.completeMilestone(pid, ms));
  await measure("approveDeliverable", () => asClient.approveDeliverable(pid, ms));
  await measure("claimMilestone (payout)", () => asClient.claimMilestone(pid, ms));

  // Worst case: many milestones open a dispute / resolve, which loop over all ids.
  for (let i = 0; i < 12; i++) {
    const c = await (await asFreelancer.createMilestone(pid, `phase ${i}`, ONE(1))).wait();
    await (await asClient.depositFunds(pid, { value: ONE(1) })).wait();
  }
  await measure("openDispute (15 milestones)", () => asClient.openDispute(pid));
  await measure("resolveDispute (15 milestones)", () => contract.connect(owner).resolveDispute(pid, true));
  // sweepSurplus needs stray ETH on top of the escrow to have anything to take.
  await (await client.sendTransaction({ to: await contract.getAddress(), value: ONE(0.05) })).wait();
  await measure("sweepSurplus", () => contract.connect(owner).sweepSurplus(ownerAddress));
  await readGas("createProject (estimate)", () => asClient.createProject.estimateGas(1, "ipfs://x"));
  await readGas("createMilestone (max desc, estimate)", () => asFreelancer.createMilestone.estimateGas(pid, maxDescription, ONE(1)));

  rows.sort((a, b) => Number(b.gas) - Number(a.gas));
  console.log("\nmethod                                    gasUsed");
  console.log("-----------------------------------------  ----------");
  for (const r of rows) console.log(`${r.label.padEnd(41)}  ${r.gas}`);

  // Only real `gasUsed` matters for choosing a gas limit; the estimate rows are
  // 2x-inflated by the padding applied to work around ganache.
  const max = Math.max(...rows.map((r) => Number(r.gas)));
  const limit = Number(process.env.TX_GAS_LIMIT || 900000);
  console.log(`\nmax measured gasUsed: ${max}`);
  console.log(`backend DEFAULT_GAS_LIMIT: ${limit} -> ${max > limit ? "TOO LOW" : "ok"}`);
  console.log(`recommended gasLimit: ${Math.ceil((max * 1.5) / 10000) * 10000}`);
  if (estimates.length) {
    console.log(`\n(for reference) padded estimates: ${estimates.map((e) => `${e.label}=${e.gas}`).join(", ")}`);
  }

  const balance = await provider.getBalance(contract.target);
  console.log(`\ncontract balance after sweep: ${ethers.formatEther(balance)} (escrow untouched)`);

  await ganacheProvider.disconnect();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
