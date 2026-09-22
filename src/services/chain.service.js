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

const PROJECT_STATUS_MAP = ["created", "funded", "in_progress", "completed", "cancelled", "disputed"];
const PROJECT_TYPE_MAP = ["fixclaim", "milestones"];

let provider = null;
let readContract = null;
let isAvailableCheckedAt = 0;
let isAvailable = false;

// ---------------------------------------------------------------------------
// Provider / contracts
// ---------------------------------------------------------------------------

const getProvider = () => {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  }
  return provider;
};

const getReadContract = () => {
  if (!readContract) {
    readContract = new ethers.Contract(CONTRACT_ADDRESS, contractData.abi, getProvider());
  }
  return readContract;
};

const getSigner = (privateKey) => new ethers.Wallet(privateKey, getProvider());

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
    await Promise.race([
      getProvider().getBlockNumber(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("RPC timeout")), 4_000)
      ),
    ]);
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
      "Blockchain node is not reachable. Start the local hardhat node and redeploy the escrow contract.",
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
 * Fresh getTransactionCount for an address using a raw RPC call. The shared
 * provider caches nonce counts per block, which breaks rapid backend relays
 * (two sends within the same block reuse the cached count -> NONCE_EXPIRED).
 */
const getExternalNonce = async (address) => {
  const hex = await getProvider().send("eth_getTransactionCount", [address, "latest"]);
  return parseInt(hex, 16);
};

/**
 * Relays a non-payable contract method with the signer built from a private key.
 * Uses a fresh explicit nonce to stay race-free under automining hardhat.
 */
const relayCall = async (privateKey, method, args = []) => {
  await assertChainAvailable();
  const signer = getSigner(privateKey);
  const nonce = await getExternalNonce(signer.address);
  return sendContractCall(signer, (contract) =>
    contract[method](...args, { gasLimit: 400000, nonce })
  );
};

/**
 * Same as relayCall but routes all options explicitly (actor key, gas, nonce).
 * Supports payable methods via `value` (in wei, ethers.BigNumberish).
 */
const relayCallAs = async ({ actorKey, method, args, gasLimit = 400000, value = null }) => {
  await assertChainAvailable();
  const signer = getSigner(actorKey);
  const nonce = await getExternalNonce(signer.address);
  const overrides = { gasLimit, nonce };
  if (value !== null && value !== undefined) {
    overrides.value = value;
  }
  return sendContractCall(signer, (contract) => contract[method](...args, overrides));
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

const isReviewLapsed = async (onChainProjectId) => {
  await assertChainAvailable();
  return getReadContract().isReviewLapsed(onChainProjectId);
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
      isCompleted: m.isCompleted,
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
      metadataHash: project.metadataHash,
      milestoneIds: milestoneIds.map((id) => Number(id)),
      milestones,
      reviewLapsed,
    };
  } catch (error) {
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
    gasLimit: 400000,
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
  getProvider,
  getReadContract,
  getSigner,
  getContract,
  isChainAvailable,
  assertChainAvailable,
  toWei,
  toEth,
  projectStatusToName,
  projectTypeToName,
  sendContractCall,
  relayCall,
  relayCallAs,
  getExternalNonce,
  getProject,
  getMilestone,
  getProjectMilestoneIds,
  getProjectMilestones,
  getProjectEscrow,
  isReviewLapsed,
  getProjectState,
  parseEventFromReceipt,
  getProjectCounter,
  getMilestoneCounter,
  buildCreateProjectPayload,
  buildDepositPayload,
};