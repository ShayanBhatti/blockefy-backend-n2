const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const chainService = require("../services/chain.service");
const walletActor = require("../services/walletActor.service");
const Project = require("../models/Project");
const { getOwnedProject, assertProjectParticipant } = require("../services/project.service");

/**
 * Escape-hatch relay whitelist.
 *
 * Deliberately EXCLUDES every method that moves money or freezes a project:
 *   - `claimMilestone`, `fixClaim`  -> release escrow to the freelancer
 *   - `retrieveFunds`               -> return escrow to the client
 *   - `openDispute`, `resolveDispute` -> freeze all funds / final ruling
 *   - `depositFunds`                -> payable, handled by the escrow service
 *
 * Those must go through their dedicated, authorized service endpoints
 * (`milestone.service`, `escrow.service`) so the on-chain event is verified
 * before the database is updated.
 */
const WHITELISTED_METHODS = [
  "createProject",
  "approveProject",
  "createMilestone",
  "completeMilestone",
  "approveDeliverable",
  "requestChanges",
  "extendDeadline",
];

const FORBIDDEN_RELAY_METHODS = [
  "claimMilestone",
  "fixClaim",
  "submitFixClaim",
  "approveFixClaim",
  "retrieveFunds",
  "openDispute",
  "resolveDispute",
  "depositFunds",
  "sweepSurplus",
  "pause",
  "unpause",
  "setPlatformFee",
  "setTreasury",
  "transferOwnership",
  "renounceOwnership",
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

    // Bytecode match: a stale Blockefy-address.json after a redeploy shows up
    // here BEFORE any user hits a failed transaction.
    try {
      await chainService.verifyDeployedContract();
      info.contractDeployed = true;
    } catch (error) {
      info.contractDeployed = false;
      info.contractDeployedError = error.message;
    }
    info.contractOwner = await chainService.getContractOwner().catch(() => null);
  }
  res.json({ success: true, data: info });
});

const getProjectState = asyncHandler(async (req, res) => {
  const project = await assertProjectParticipant({ projectId: req.params.projectId, user: req.authUser });
  if (!project.onChainProjectId) {
    return res.json({ success: true, data: { onChainProjectId: null, message: "Not on chain yet" } });
  }
  const state = await chainService.getProjectState(project.onChainProjectId);
  res.json({ success: true, data: state });
});

/**
 * Relays a non-payable, non-value-moving contract call with the acting user's
 * wallet key. Used as an escape hatch for actions not covered by feature
 * routes. Money movement and disputes are NOT reachable from here - see
 * WHITELISTED_METHODS.
 */
const relay = asyncHandler(async (req, res) => {
  const { method, args = [], projectId } = req.body || {};
  if (!method || !WHITELISTED_METHODS.includes(method)) {
    const hint = FORBIDDEN_RELAY_METHODS.includes(method)
      ? " Use the dedicated escrow endpoint for this action."
      : "";
    throw new AppError(`Method not whitelisted.${hint}`, 400, "INVALID_METHOD");
  }
  if (!Array.isArray(args)) {
    throw new AppError("args must be an array", 400, "VALIDATION");
  }
  if (args.some((a) => typeof a === "object" && a !== null && !Array.isArray(a))) {
    throw new AppError("args must be primitive values (bigints as strings)", 400, "VALIDATION");
  }
  const user = req.authUser;
  if (!user.walletPrivateKey && !user.externalWallet?.privateKey) {
    throw new AppError("No backend wallet key available for this account", 422, "NO_RELAY");
  }
  // Every whitelisted method except `createProject` is scoped to an existing
  // project. Participation is REQUIRED: without this, any authenticated user could
  // relay calls against someone else's project (the contract would reject the
  // role, but the attempt must never be allowed to reach the chain).
  //
  // The project id is taken from the body OR args[0]. Deriving it from args[0]
  // matters: it was previously taken only from the body, so omitting `projectId`
  // skipped this check entirely while still relaying a project-scoped call.
  if (method !== "createProject") {
    const targetProjectId = projectId || args[0];
    if (targetProjectId === undefined || targetProjectId === null || targetProjectId === "") {
      throw new AppError("projectId is required for this method", 400, "VALIDATION");
    }
    const ok = await assertProjectParticipant({ projectId: targetProjectId, user });
    if (!ok) throw new AppError("Not authorized", 403, "FORBIDDEN");
  }

  // Relaying as the caller means the contract records THEM as the actor. Refuse a
  // key that controls a different address, which would permanently lock the wrong
  // role onto the on-chain project.
  // For a project-scoped call, resolve whichever of the caller's keys controls
  // the address the CONTRACT already recorded for them - a project published
  // before they imported a key still requires the original wallet.
  const targetProjectId = method === "createProject" ? null : projectId || args[0];
  const scopedProject = targetProjectId ? await Project.findById(targetProjectId) : null;
  const { actorKey, actorAddress } = await walletActor.resolveActorKey({
    user,
    project: scopedProject || undefined,
    party: "client",
    label: "You",
  });
  if (!actorKey) {
    throw new AppError("No backend wallet key available for this account", 422, "NO_RELAY");
  }
  chainService.assertKeyControlsAddress(actorKey, actorAddress, "You");

  const bigintised = args.map((a) => (typeof a === "string" && /^\d+$/.test(a) ? BigInt(a) : a));
  const { txHash } = await chainService.relayCallAs({
    actorKey,
    method,
    args: bigintised,
    context: {
      userId: user._id,
      projectId: scopedProject?._id || null,
      description: `Relayed ${method} on-chain`,
    },
  });
  res.json({ success: true, data: { method, args, txHash } });
});

module.exports = {
  getContractInfo,
  getProjectState,
  relay,
};