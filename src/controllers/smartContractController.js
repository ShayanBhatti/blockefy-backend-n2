const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const chainService = require("../services/chain.service");
const { getOwnedProject } = require("../services/project.service");

/**
 * Generic Blockefy contract endpoints: chain health info, on-chain project
 * state and a whitelisted relay for non-payable contract calls.
 */

const WHITELISTED_METHODS = [
  "createProject",
  "approveProject",
  "createMilestone",
  "completeMilestone",
  "approveDeliverable",
  "requestChanges",
  "extendDeadline",
  "claimMilestone",
  "fixClaim",
  "retrieveFunds",
  "openDispute",
  "resolveDispute",
];

const getContractInfo = asyncHandler(async (req, res) => {
  const available = await chainService.isChainAvailable();
  let info = {
    chainId: chainService.CHAIN_ID,
    contractAddress: chainService.CONTRACT_ADDRESS,
    rpcUrl: chainService.RPC_URL,
    available,
  };
  if (available) {
    const [blockNumber, projectCounter, milestoneCounter, network] = await Promise.all([
      chainService.getProvider().getBlockNumber(),
      chainService.getProjectCounter(),
      chainService.getMilestoneCounter(),
      chainService.getProvider().getNetwork().catch(() => null),
    ]);
    info.latestBlock = blockNumber;
    info.projectCounter = projectCounter;
    info.milestoneCounter = milestoneCounter;
    info.networkName = network ? network.name : null;
  }
  res.json({ success: true, data: info });
});

const getProjectState = asyncHandler(async (req, res) => {
  const project = await getOwnedProject({ projectId: req.params.projectId, user: req.authUser });
  if (!project.onChainProjectId) {
    return res.json({ success: true, data: { onChainProjectId: null, message: "Not on chain yet" } });
  }
  const state = await chainService.getProjectState(project.onChainProjectId);
  res.json({ success: true, data: state });
});

/**
 * Relays a non-payable contract call with the acting user's wallet key.
 * `amountEth` is ignored (no payable relay) — payable calls (depositFunds)
 * must be signed by the user's wallet. Used as an escape hatch for actions
 * not covered by feature routes.
 */
const relay = asyncHandler(async (req, res) => {
  const { method, args = [], projectId } = req.body || {};
  if (!method || !WHITELISTED_METHODS.includes(method)) {
    throw new AppError("Method not whitelisted", 400, "INVALID_METHOD");
  }
  if (!Array.isArray(args)) {
    throw new AppError("args must be an array", 400, "VALIDATION");
  }
  if (args.some((a) => typeof a === "object" && a !== null && !Array.isArray(a))) {
    throw new AppError("args must be primitive values (bigints as strings)", 400, "VALIDATION");
  }
  const user = req.authUser;
  if (!user.walletPrivateKey) {
    throw new AppError("No backend wallet key available for this account", 422, "NO_RELAY");
  }
  const ownerOk = String(projectId || "") === "" ||
    String((await getOwnedProject({ projectId, user })).buyerId) === String(user._id) ||
    user.role === "admin";
  if (!ownerOk) throw new AppError("Not authorized", 403, "FORBIDDEN");

  const bigintised = args.map((a) => (typeof a === "string" && /^\d+$/.test(a) ? BigInt(a) : a));
  const { txHash } = await chainService.relayCallAs({
    actorKey: user.walletPrivateKey,
    method,
    args: bigintised,
  });
  res.json({ success: true, data: { method, args, txHash } });
});

module.exports = {
  getContractInfo,
  getProjectState,
  relay,
};