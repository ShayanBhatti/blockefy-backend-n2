const { ethers } = require("ethers");
const AppError = require("../utils/AppError");

const contractData = require("../../contracts/contractsData/Blockefy.json");
const addressData = require("../../contracts/contractsData/Blockefy-address.json");

/**
 * Blockchain (Blockefy escrow contract) integration.
 *
 * Pure-ETH escrow on the local hardhat network (chainId 31337). The contract
 * `createProject`/`approveProject`/`createMilestone`/`completeMilestone`/
 * `approveDeliverable`/`requestChanges`/`claimMilestone`/`fixClaim`/
 * `retrieveFunds`/`openDispute`/`resolveDispute` calls are executed through the
 * ethers provider. Contracts are referenced by address + ABI shipped in
 * `contracts/contractsData` and overridable via env vars.
 *
 * SIGNING MODEL (backend-relayed):
 *   All state calls - including the payable depositFunds - are RELAYED by the
 *   backend using the stored `walletPrivateKey` of the acting user (or the
 *   seeded admin key as fallback). The frontend never signs via MetaMask.
 */

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || addressData.address;
const CONFIRMATIONS = Number(process.env.TX_CONFIRMATIONS || 1);
const DEFAULT_REVIEW_WINDOW_SECONDS = 15 * 24 * 60 * 60;

/**
 * Gas limit for relayed calls.
 *
 * Measured against the real contract with `npm run measure:gas`:
 *   openDispute / resolveDispute (15 milestones) ~ 180k
 *   createProject                            ~ 180k
 *   createMilestone (500-byte description)   ~ 550k  <- worst case
 * 900k leaves ~60% headroom over the worst measured path while staying well
 * inside the BSC block gas limit. `MAX_DESCRIPTION_LENGTH` in the contract is
 * what actually bounds this; re-measure if that cap changes.
 */
const DEFAULT_GAS_LIMIT = Number(process.env.TX_GAS_LIMIT || 900000);

/**
 * RPC endpoints, tried in order. Public endpoints on the free tier rate-limit
 * (dRPC answers `408 / code 30 "Request timeout on the free plan"`), so the
 * relay fails over instead of hard-failing. Override with RPC_URLS="a,b".
 */
const DEFAULT_FALLBACK_RPCS = {
  97: [
    "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    "https://bsc-testnet-rpc.publicnode.com",
    "https://bsc-testnet.publicnode.com",
    "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
  ],
  31337: [],
};

const RPC_URLS = Array.from(
  new Set(
    [
      ...String(process.env.RPC_URLS || "")
        .split(",")
        .map((u) => u.trim()),
      RPC_URL,
      ...(DEFAULT_FALLBACK_RPCS[CHAIN_ID] || []),
    ].filter((u) => /^https?:\/\//.test(u))
  )
);

const PROJECT_STATUS_MAP = ["created", "funded", "in_progress", "completed", "cancelled", "disputed"];
const PROJECT_TYPE_MAP = ["fixclaim", "milestones"];

let provider = null;
let readContract = null;
let isAvailableCheckedAt = 0;
let isAvailable = false;

const providersByUrl = new Map();
const rpcCooldownUntil = new Map();
let activeRpcIndex = 0;

const RPC_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Provider / contracts
// ---------------------------------------------------------------------------

const getProviderByUrl = (url) => {
  if (!providersByUrl.has(url)) {
    providersByUrl.set(
      url,
      new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true })
    );
  }
  return providersByUrl.get(url);
};

const getProvider = () => getProviderByUrl(RPC_URLS[activeRpcIndex] || RPC_URL);

/**
 * Distinguishes "this endpoint is unhealthy" (timeouts, 408/429/5xx, socket
 * errors) from deterministic on-chain failures (revert, insufficient funds),
 * which would fail identically on every endpoint and must not trigger failover.
 */
const isRpcTransportError = (error) => {
  if (!error) return false;
  const code = String(error.code || "");
  const message = String(error.message || "").toLowerCase();
  const status = Number(error.info?.responseStatus || error.statusCode || 0);
  if (["TIMEOUT", "SERVER_ERROR", "NETWORK_ERROR", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }
  if (status === 408 || status === 429 || status >= 500) return true;
  if (/insufficient funds|execution reverted|call revert|nonce (too low|too high)|already known|replacement transaction underpriced/.test(message)) {
    return false;
  }
  return /request timeout|free plan|rate limit|too many requests|socket hang up|fetch failed|network (error|request failed)|bad response|service unavailable|gateway|timeout/.test(
    message
  );
};

/**
 * Runs an operation against the RPC endpoints, failing over to the next one
 * when an endpoint looks unhealthy (and remembering it for a cooldown so a
 * dead endpoint is skipped first next time). Deterministic chain errors are
 * rethrown immediately.
 */
const withRpcFailover = async (operation) => {
  const order = [
    ...[activeRpcIndex, ...RPC_URLS.keys()].filter(
      (i, idx, arr) => i < RPC_URLS.length && arr.indexOf(i) === idx
    ),
  ];
  let lastError = null;
  let attempted = 0;

  for (const index of order) {
    const url = RPC_URLS[index];
    if (!url) continue;
    if ((rpcCooldownUntil.get(url) || 0) > Date.now()) continue;
    attempted += 1;
    try {
      const result = await operation(getProviderByUrl(url), url);
      activeRpcIndex = index;
      rpcCooldownUntil.delete(url);
      return result;
    } catch (error) {
      lastError = error;
      if (!isRpcTransportError(error)) throw error;
      rpcCooldownUntil.set(url, Date.now() + RPC_COOLDOWN_MS);
    }
  }

  if (!lastError) {
    throw new Error("No healthy RPC endpoint configured");
  }
  throw lastError;
};

const getReadContract = () => {
  // Rebuild if failover rotated us to a different endpoint.
  if (!readContract || readContract.provider !== getProvider()) {
    readContract = new ethers.Contract(CONTRACT_ADDRESS, contractData.abi, getProvider());
  }
  return readContract;
};

const getSignerWithProvider = (privateKey, rpc = getProvider()) =>
  new ethers.Wallet(privateKey, rpc);

const getSigner = (privateKey) => getSignerWithProvider(privateKey);

const getContract = (signer) =>
  new ethers.Contract(CONTRACT_ADDRESS, contractData.abi, signer);

/**
 * Cheap reachability probe (cached 30s). Lets controllers return a friendly
 * "chain unavailable" error instead of a raw ethers ECONNREFUSED.
 */
const isChainAvailable = async () => {
  const now = Date.now();
  if (now - isAvailableCheckedAt < 30_000) return isAvailable;
  try {
    await withRpcFailover((rpc) =>
      Promise.race([
        rpc.getBlockNumber(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RPC timeout")), 8_000)
        ),
      ])
    );
    isAvailable = true;
  } catch {
    isAvailable = false;
  }
  isAvailableCheckedAt = now;
  return isAvailable;
};

const assertChainAvailable = async () => {
  if (!(await isChainAvailable())) {
    throw new AppError(
      `Blockchain node is not reachable (chainId ${CHAIN_ID}). Check RPC_URL/RPC_URLS and try again.`,
      503,
      "CHAIN_UNAVAILABLE"
    );
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toWei = (ethAmount) => ethers.parseEther(String(ethAmount));
const toEth = (weiAmount) => ethers.formatEther(weiAmount || 0);

const projectStatusToName = (code) => PROJECT_STATUS_MAP[Number(code)] || "unknown";
const projectTypeToName = (code) => PROJECT_TYPE_MAP[Number(code)] || "unknown";

/**
 * Sends a prepared contract call and waits for confirmation.
 *
 * @param {import("ethers").Wallet} signer - Wallet that signs the transaction.
 * @param {(contract: import("ethers").Contract) => Promise<import("ethers").TransactionResponse>} call
 * @param {Object} [opts]
 * @param {number} [opts.confirmations]
 * @returns {Promise<{txHash: string, receipt: import("ethers").TransactionReceipt}>}
 */
const sendContractCall = async (signer, call, opts = {}) => {
  const contract = getContract(signer);
  const tx = await call(contract);
  const receipt = await tx.wait(opts.confirmations || CONFIRMATIONS);
  return { txHash: receipt.hash, receipt };
};

/**
 * Best-effort audit write for a relayed call.
 *
 * Recording must never break a transaction that already went through, so any
 * failure here is logged and swallowed. The private key is never passed in -
 * only the derived address.
 */
const recordChainEvent = async (event) => {
  try {
    const ChainEvent = require("../models/ChainEvent");
    await ChainEvent.create({
      chainId: Number(CHAIN_ID),
      contractAddress: CONTRACT_ADDRESS,
      ...event,
    });
  } catch (err) {
    console.warn(`[CHAIN-EVENT] ${event.method} could not be recorded: ${err.message}`);
  }
};

/**
 * Fresh getTransactionCount for an address using a raw RPC call. The shared
 * provider caches nonce counts per block, which breaks rapid backend relays
 * (two sends within the same block reuse the cached count -> NONCE_EXPIRED).
 */
const getExternalNonce = async (address, rpc = getProvider()) => {
  const hex = await rpc.send("eth_getTransactionCount", [address, "latest"]);
  return parseInt(hex, 16);
};

/** Native BNB balance of an address, in wei. Source of truth for the wallet page. */
const getNativeBalance = async (address, rpc = getProvider()) => {
  await assertChainAvailable();
  return rpc.getBalance(address);
};

/**
 * Relays a non-payable contract method with the signer built from a private key.
 * Uses a fresh explicit nonce to stay race-free under automining hardhat, and
 * fails over to a healthy RPC endpoint when one is rate-limiting.
 *
 * @param {string} privateKey
 * @param {string} method
 * @param {Array} args
 * @param {Object} [context] audit hints: { userId, projectId, milestoneId, proposalId, description }
 */
const relayCall = async (privateKey, method, args = [], context = {}) => {
  await assertChainAvailable();
  await verifyDeployedContract();
  const actorAddress = addressFromPrivateKey(privateKey).toLowerCase();
  try {
    const result = await withRpcFailover(async (rpc) => {
      const signer = getSignerWithProvider(privateKey, rpc);
      const nonce = await getExternalNonce(signer.address, rpc);
      return sendContractCall(signer, (contract) =>
        contract[method](...args, { gasLimit: DEFAULT_GAS_LIMIT, nonce })
      );
    });
    await recordChainEvent({
      txHash: result.txHash,
      blockNumber: result.receipt?.blockNumber ?? null,
      actorAddress,
      method,
      status: "confirmed",
      ...pickAuditContext(context),
    });
    return result;
  } catch (err) {
    await recordChainEvent({
      actorAddress,
      method,
      status: "failed",
      error: String(err.message || err).slice(0, 300),
      ...pickAuditContext(context),
    });
    throw err;
  }
};

/** Keep only known audit fields so callers can pass a loaded mongoose doc. */
const pickAuditContext = (context = {}) => ({
  userId: context.userId ?? context.user?._id ?? null,
  projectId: context.projectId ?? context.project?._id ?? null,
  milestoneId: context.milestoneId ?? context.milestone?._id ?? null,
  proposalId: context.proposalId ?? context.proposal?._id ?? null,
  description: context.description ?? null,
});

/**
 * Same as relayCall but routes all options explicitly (actor key, gas, nonce).
 * Supports payable methods via `value` (in wei, ethers.BigNumberish).
 *
 * @param {Object} params
 * @param {string} params.actorKey
 * @param {string} params.method
 * @param {Array}  [params.args]
 * @param {number} [params.gasLimit]
 * @param {any}    [params.value] wei for payable methods
 * @param {Object} [params.context] audit hints, see relayCall
 */
const relayCallAs = async ({ actorKey, method, args = [], gasLimit = DEFAULT_GAS_LIMIT, value = null, context = {} }) => {
  await assertChainAvailable();
  await verifyDeployedContract();
  const actorAddress = addressFromPrivateKey(actorKey).toLowerCase();
  const audit = {
    ...pickAuditContext(context),
    valueWei: value === null || value === undefined ? null : String(value),
  };
  try {
    const result = await withRpcFailover(async (rpc) => {
      const signer = getSignerWithProvider(actorKey, rpc);
      const nonce = await getExternalNonce(signer.address, rpc);
      const overrides = { gasLimit, nonce };
      if (value !== null && value !== undefined) {
        overrides.value = value;
      }
      return sendContractCall(signer, (contract) => contract[method](...args, overrides));
    });
    await recordChainEvent({
      txHash: result.txHash,
      blockNumber: result.receipt?.blockNumber ?? null,
      actorAddress,
      method,
      status: "confirmed",
      ...audit,
    });
    return result;
  } catch (err) {
    await recordChainEvent({
      actorAddress,
      method,
      status: "failed",
      error: String(err.message || err).slice(0, 300),
      ...audit,
    });
    throw err;
  }
};

// ---------------------------------------------------------------------------
// On-chain view helpers
// ---------------------------------------------------------------------------

const getProject = async (onChainProjectId) => {
  await assertChainAvailable();
  const contract = getReadContract();
  const project = await contract.projects(onChainProjectId);
  return project;
};

const getMilestone = async (onChainMilestoneId) => {
  await assertChainAvailable();
  const contract = getReadContract();
  return contract.milestones(onChainMilestoneId);
};

const getProjectMilestoneIds = async (onChainProjectId) => {
  await assertChainAvailable();
  return getReadContract().getProjectMilestones(onChainProjectId);
};

const getProjectMilestones = async (onChainProjectId) => {
  await assertChainAvailable();
  return getReadContract().getMilestonesDetails(onChainProjectId);
};

const getProjectEscrow = async (onChainProjectId) => {
  await assertChainAvailable();
  return getReadContract().getProjectEscrow(onChainProjectId);
};

/**
 * Strips the trailing CBOR metadata (a keccak of the source, plus solc settings)
 * from a runtime bytecode blob.
 *
 * The metadata is the last thing solc appends to `deployedBytecode`, and its
 * final two bytes hold its own length. It must be ignored when comparing on-chain
 * code to a local build: the SAME contract compiled from a different source layout
 * (e.g. the flattened `Blockefy.remix.sol` that gets pasted into Remix) has
 * byte-identical executable code but a different metadata hash. Comparing the
 * full blob would reject a perfectly valid deployment.
 */
const stripSolidityMetadata = (bytecode) => {
  const hex = (bytecode || "0x").toLowerCase().replace(/^0x/, "");
  if (hex.length < 4) return `0x${hex}`;
  const metadataLength = parseInt(hex.slice(-4), 16);
  // A bogus length means the blob is not solc output; fall back to the raw bytes.
  if (!Number.isFinite(metadataLength) || metadataLength * 2 + 4 > hex.length) {
    return `0x${hex}`;
  }
  return `0x${hex.slice(0, hex.length - 4 - metadataLength * 2)}`;
};

/**
 * keccak256 of the artifact's *executable* runtime bytecode (metadata stripped).
 * Compared against the code at CONTRACT_ADDRESS so a stale address file can never
 * silently decode garbage or produce confusing reverts after a contract upgrade.
 */
const RUNTIME_BYTECODE_HASH = (() => {
  // solc emits runtime code as `deployedBytecode`; `bytecode` is creation code
  // and must NOT be compared against an address.
  const runtime = contractData.deployedBytecode;
  if (!runtime || runtime === "0x") {
    throw new Error(
      "contracts/contractsData/Blockefy.json has no `deployedBytecode`. Re-run: npm run compile:contract"
    );
  }
  return ethers.keccak256(stripSolidityMetadata(runtime));
})();

/** The full (metadata-inclusive) hash, for diagnostics only. */
const RUNTIME_BYTECODE_HASH_FULL = ethers.keccak256(contractData.deployedBytecode || "0x");

let bytecodeCheck = null;

/**
 * Verifies the contract deployed at CONTRACT_ADDRESS matches the local artifact.
 *
 * Cached for 60s. A mismatch is fatal for every state-changing call, so it is
 * surfaced as a 503 with actionable instructions rather than an opaque revert.
 */
const verifyDeployedContract = async () => {
  if (bytecodeCheck && Date.now() - bytecodeCheck.checkedAt < 60_000) {
    if (bytecodeCheck.error) throw bytecodeCheck.error;
    return bytecodeCheck;
  }

  let result;
  try {
    await assertChainAvailable();
    const code = await withRpcFailover((rpc) => rpc.getCode(CONTRACT_ADDRESS));
    if (!code || code === "0x") {
      result = {
        ok: false,
        error: new AppError(
          `No contract deployed at ${CONTRACT_ADDRESS} on chainId ${CHAIN_ID}. ` +
            "Deploy Blockefy.sol first, then set CONTRACT_ADDRESS or update Blockefy-address.json.",
          503,
          "CONTRACT_NOT_DEPLOYED"
        ),
      };
    } else {
      const actual = ethers.keccak256(stripSolidityMetadata(code));
      if (actual.toLowerCase() !== RUNTIME_BYTECODE_HASH.toLowerCase()) {
        result = {
          ok: false,
          error: new AppError(
            `The contract at ${CONTRACT_ADDRESS} does not match contracts/contractsData/Blockefy.json ` +
              `(on-chain code ${actual.slice(0, 10)}..., local ${RUNTIME_BYTECODE_HASH.slice(0, 10)}...). ` +
              "Recompile (npm run compile:contract), redeploy, then update " +
              "contracts/contractsData/Blockefy-address.json or CONTRACT_ADDRESS.",
            503,
            "CONTRACT_MISMATCH"
          ),
        };
      } else {
        result = { ok: true, error: null };
      }
    }
  } catch (error) {
    result = { ok: false, error };
  }

  bytecodeCheck = { ...result, checkedAt: Date.now() };
  if (bytecodeCheck.error) throw bytecodeCheck.error;
  return bytecodeCheck;
};

/** Drops the cached bytecode check (used by tests and after a redeploy). */
const resetBytecodeCheck = () => {
  bytecodeCheck = null;
};

const isReviewLapsed = async (onChainProjectId) => {
  await assertChainAvailable();
  return getReadContract().isReviewLapsed(onChainProjectId);
};

/**
 * Total ETH the contract holds as client escrow. `sweepSurplus` is bounded by
 * this, so it can never remove escrowed principal.
 */
const getTotalEscrowed = async () => {
  await assertChainAvailable();
  return getReadContract().totalEscrowed();
};

/**
 * Resolves the on-chain admin (contract owner). Any key used for an `onlyOwner`
 * call (resolveDispute, pause, setPlatformFee, ...) MUST belong to this address.
 */
const getContractOwner = async () => {
  await assertChainAvailable();
  return getReadContract().owner();
};

/**
 * Derives the address that `privateKey` controls, without touching the network.
 *
 * Use this to prove a relay will be sent by the EXPECTED actor. Several contract
 * functions are role-locked (`onlyClient`, `onlyFreelancer`, `onlyOwner`), and
 * sending them from the wrong account either reverts or, worse, permanently
 * records the wrong party on-chain while the database records the right one.
 */
const addressFromPrivateKey = (privateKey) => getSigner(privateKey).address;

/**
 * Throws unless `privateKey` controls `expectedAddress`.
 * @param {string} privateKey
 * @param {string} expectedAddress the address the contract will see as msg.sender
 * @param {string} actorLabel human-readable role, used in the error message
 */
const assertKeyControlsAddress = (privateKey, expectedAddress, actorLabel = "this account") => {
  if (!expectedAddress) {
    throw new AppError(
      `${actorLabel} has no wallet address on file, so it cannot sign this transaction`,
      422,
      "NO_RELAY"
    );
  }
  const actual = addressFromPrivateKey(privateKey);
  if (String(actual).toLowerCase() !== String(expectedAddress).toLowerCase()) {
    throw new AppError(
      `The wallet key on file does not match ${actorLabel}'s wallet address ` +
        `(${actual} vs ${expectedAddress}). Relaying as another account would lock ` +
        "the contract role to the wrong party.",
      409,
      "WALLET_KEY_MISMATCH"
    );
  }
  return actual;
};

/**
 * Asserts that `privateKey` controls the on-chain owner, so admin relays fail
 * with a clear 4xx instead of an opaque contract revert.
 */
const assertContractOwnerKey = async (privateKey) => {
  const signer = getSigner(privateKey);
  const ownerAddress = await getContractOwner();
  if (String(signer.address).toLowerCase() !== String(ownerAddress).toLowerCase()) {
    throw new AppError(
      "The configured admin wallet is not the on-chain contract owner",
      422,
      "NOT_CONTRACT_OWNER"
    );
  }
  return signer.address;
};

/**
 * Full on-chain state of a project, normalized to plain JSON-safe values.
 */
const getProjectState = async (onChainProjectId) => {
  const contract = getReadContract();
  await assertChainAvailable();

  try {
    const [project, milestoneIds, milestonesDetails, escrowWei, reviewLapsed] =
      await Promise.all([
        contract.projects(onChainProjectId),
        contract.getProjectMilestones(onChainProjectId),
        contract.getMilestonesDetails(onChainProjectId),
        contract.getProjectEscrow(onChainProjectId),
        contract.isReviewLapsed(onChainProjectId),
      ]);

    const milestones = milestonesDetails.map((m, i) => ({
      id: Number(m.id),
      description: m.description,
      amountEth: Number(toEth(m.amount)),
      isFunded: m.isFunded,
      isCompleted: m.isCompleted,
      isApproved: m.isApproved,
      isClaimed: m.isClaimed,
      isDisputed: m.isDisputed,
      claimedAt: Number(m.claimedAt),
    }));

    return {
      onChainProjectId: Number(onChainProjectId),
      clientAddress: project.client,
      freelancerAddress: project.freelancer,
      projectType: projectTypeToName(project.projectType),
      status: projectStatusToName(project.status),
      statusCode: Number(project.status),
      totalFundedEth: Number(toEth(project.totalFunded)),
      escrowEth: Number(toEth(escrowWei)),
      deadline: project.deadline ? Number(project.deadline) : null,
      reviewWindowSeconds: Number(project.reviewWindow),
      lastReviewAt: Number(project.lastReviewAt),
      changesCount: Number(project.changesCount),
      isSubmitted: project.isSubmitted,
      isDeliverableAccepted: project.isDeliverableAccepted,
      isProjectFunded: project.isProjectFunded,
      fixClaimAmountEth: Number(toEth(project.fixClaimAmount)),
      metadataHash: project.metadataHash,
      milestoneIds: milestoneIds.map((id) => Number(id)),
      milestones,
      reviewLapsed,
    };  } catch (error) {
    // A missing on-chain record returns empty calldata and fails decoding:
    // treat it as "project not deployed/funded yet" instead of a 500 so the
    // client & freelancer views still render.
    if (
      /could not decode result data/.test(String(error?.message || "")) ||
      /Returned values aren't valid/.test(String(error?.message || ""))
    ) {
      return null;
    }
    throw error;
  }
};

/**
 * Parses a single named event out of a transaction receipt.
 * @returns {Object|null} { name, args } or null when not found.
 */
const parseEventFromReceipt = (receipt, eventName) => {
  if (!receipt || !receipt.logs) return null;
  const iface = new ethers.Interface(contractData.abi);
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === eventName) {
        return { name: parsed.name, args: parsed.args };
      }
    } catch {
      // unrelated / non-contract log
    }
  }
  return null;
};

const getProjectCounter = async () => {
  await assertChainAvailable();
  return Number(await getReadContract().projectCounter());
};

const getMilestoneCounter = async () => {
  await assertChainAvailable();
  return Number(await getReadContract().milestoneCounter());
};

/**
 * Builds the client-side (MetaMask) transaction payload for creating a project
 * (used only when the acting user has no stored private key to relay with).
 */
const buildCreateProjectPayload = async ({ metadataHash = "" }) => {
  await assertChainAvailable();
  const tx = await getReadContract().createProject.populateTransaction(1, metadataHash, {
    gasLimit: DEFAULT_GAS_LIMIT,
  });
  return {
    to: CONTRACT_ADDRESS,
    value: "0",
    data: tx.data,
    functionName: "createProject",
    args: [1, metadataHash],
    chainId: CHAIN_ID,
    from: tx.from || null,
  };
};

/**
 * Builds the client-side (MetaMask) transaction payload for a deposit.
 * @param {Object} opts
 * @param {number} opts.onChainProjectId
 * @param {string|number} opts.amountEth
 */
const buildDepositPayload = async ({ onChainProjectId, amountEth }) => {
  await assertChainAvailable();
  const value = toWei(amountEth);
  const tx = await getReadContract().depositFunds.populateTransaction(onChainProjectId, {
    value,
  });
  return {
    to: CONTRACT_ADDRESS,
    value: value.toString(),
    data: tx.data,
    functionName: "depositFunds",
    args: [onChainProjectId],
    chainId: CHAIN_ID,
    from: tx.from || null,
  };
};

module.exports = {
  RPC_URL,
  CHAIN_ID,
  CONTRACT_ADDRESS,
  ABI: contractData.abi,
  DEFAULT_REVIEW_WINDOW_SECONDS,
  DEFAULT_GAS_LIMIT,
  getProvider,
  getReadContract,
  getSigner,
  getContract,
  isChainAvailable,
  assertChainAvailable,
  verifyDeployedContract,
  resetBytecodeCheck,
  RUNTIME_BYTECODE_HASH,
  RUNTIME_BYTECODE_HASH_FULL,
  stripSolidityMetadata,
  toWei,
  toEth,
  projectStatusToName,
  projectTypeToName,
  sendContractCall,
  relayCall,
  relayCallAs,
  getExternalNonce,
  getNativeBalance,
  recordChainEvent,
  getProject,
  getMilestone,
  getProjectMilestoneIds,
  getProjectMilestones,
  getProjectEscrow,
  isReviewLapsed,
  getTotalEscrowed,
  getContractOwner,
  assertContractOwnerKey,
  addressFromPrivateKey,
  assertKeyControlsAddress,
  getProjectState,
  parseEventFromReceipt,
  getProjectCounter,
  getMilestoneCounter,
  buildCreateProjectPayload,
  buildDepositPayload,
};