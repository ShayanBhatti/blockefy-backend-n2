const { ethers } = require("ethers");
const AppError = require("../utils/AppError");
const chainService = require("./chain.service");

/**
 * Single source of truth for "which private key signs this on-chain call".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A user can legitimately hold TWO keys:
 *
 *   1. `walletAddress` + `walletPrivateKey` - the custodial pair minted at
 *      signup. Funds live here for any project published before an import.
 *   2. `externalWallet.address` + `externalWallet.privateKey` - the user's own
 *      MetaMask, whose key they supplied via POST /wallet/key/import.
 *
 * The contract locks identity at publish time: `createProject` records
 * `msg.sender` as `project.client`, and `onlyClient` then requires
 * `msg.sender == projects[id].client` for approveProject, depositFunds,
 * approveDeliverable, approveFixClaim, requestChanges, extendDeadline and
 * retrieveFunds.
 *
 * So the correct signer for an existing project is NOT a matter of preference -
 * it is whichever key controls that project's recorded on-chain client.
 * Choosing the "wrong" wallet reverts with
 * "Blockefy: caller is not the client", or silently spends from the wrong
 * address. This module resolves that from the chain rather than from a guess.
 *
 * Every relay site should call `resolveActorKey` instead of reading
 * `user.walletPrivateKey` directly.
 *
 * ---------------------------------------------------------------------------
 * RULES
 * ---------------------------------------------------------------------------
 * - Project already on chain  -> use the key matching its on-chain client.
 * - Project not yet on chain   -> use the user's preferred wallet
 *                                 (`walletMode`: "external" when imported).
 * - Never fall back to an admin key: an admin is not a valid actor under
 *   `onlyClient`, so the call would always revert.
 */

const norm = (address) => (address ? String(address).trim().toLowerCase() : null);

/** The two wallets a user can sign with, in preference order for NEW projects. */
const listCandidateWallets = (user) => {
  const candidates = [];

  if (user?.externalWallet?.address && user?.externalWallet?.privateKey) {
    candidates.push({
      source: "external",
      address: norm(user.externalWallet.address),
      privateKey: user.externalWallet.privateKey,
    });
  }

  if (user?.walletAddress && user?.walletPrivateKey) {
    candidates.push({
      source: "custodial",
      address: norm(user.walletAddress),
      privateKey: user.walletPrivateKey,
    });
  }

  return candidates;
};

/**
 * Find the candidate key that actually derives `expectedAddress`.
 * Guards against a stored key that has drifted from its recorded address.
 */
const keyForAddress = (user, expectedAddress, label) => {
  const target = norm(expectedAddress);
  if (!target) return null;

  for (const candidate of listCandidateWallets(user)) {
    if (candidate.address !== target) continue;
    try {
      const derived = new ethers.Wallet(candidate.privateKey).address.toLowerCase();
      if (derived !== target) continue; // stale key - never impersonate with it
      return candidate;
    } catch (_) {
      // Unusable key for this address; try the next candidate.
    }
  }
  return null;
};

/** The wallet that should sign for a brand-new, not-yet-published project. */
const preferredCandidate = (user) => {
  const candidates = listCandidateWallets(user);
  if (candidates.length === 0) return null;

  if (user?.walletMode === "external") {
    const external = candidates.find((c) => c.source === "external");
    if (external) return external;
  }
  return candidates.find((c) => c.source === "custodial") || candidates[0];
};

/**
 * Read the authoritative on-chain client/freelancer for a project.
 *
 * Distinguishes two outcomes, because conflating them is dangerous:
 *   - an address -> the chain named a party, use it
 *   - null       -> the chain answered and that party is unset (ZeroAddress)
 *
 * An RPC failure throws instead of returning null: null would make
 * `resolveActorKey` fall through to the preference rule and sign as the WRONG
 * wallet, which reverts deep inside the contract.
 */
const readOnChainParty = async ({ onChainProjectId, party }) => {
  if (!onChainProjectId) return null;
  let onChain;
  try {
    onChain = await chainService.getProject(Number(onChainProjectId));
  } catch (err) {
    throw new AppError(
      `Could not read project #${onChainProjectId} from the chain, so it is not safe to choose a signing wallet`,
      503,
      "CHAIN_UNAVAILABLE",
      { cause: err?.message }
    );
  }
  const value = onChain?.[party];
  return value && String(value) !== ethers.ZeroAddress ? norm(value) : null;
};

/**
 * Resolve the key for a project-scoped relay call.
 *
 * @param {Object}  params
 * @param {Object}  params.user       mongoose user doc (or lean object)
 * @param {Object}  [params.project]  project doc (needs onChainProjectId)
 * @param {string}  [params.party]    "client" (default) or "freelancer"
 * @param {string}  [params.label]    actor label used in error messages
 * @returns {{ actorKey: string|null, actorAddress: string|null, source: string|null }}
 */
const resolveActorKey = async ({ user, project = null, party = "client", label = "this account" } = {}) => {
  if (!user) return { actorKey: null, actorAddress: null, source: null };

  const onChainProjectId = project?.onChainProjectId;

  if (onChainProjectId) {
    const onChainParty = await readOnChainParty({ onChainProjectId, party });
    if (onChainParty) {
      const match = keyForAddress(user, onChainParty, label);
      if (match) {
        return { actorKey: match.privateKey, actorAddress: match.address, source: match.source };
      }
      // The chain names a party address we hold no key for. Guessing would sign
      // as the wrong wallet and revert deep inside the contract, so refuse.
      throw new AppError(
        `No stored key controls ${label}'s on-chain address for project #${onChainProjectId}`,
        409,
        "ACTOR_KEY_UNAVAILABLE",
        {
          onChainProjectId,
          onChainAddress: onChainParty,
        }
      );
    }
    // The chain answered but this party is not set yet (ZeroAddress), so there is
    // no identity to honour - use the user's own wallet. A chain that cannot be
    // read throws above rather than landing here.
  }

  const preferred = preferredCandidate(user);
  if (!preferred) return { actorKey: null, actorAddress: null, source: null };
  return { actorKey: preferred.privateKey, actorAddress: preferred.address, source: preferred.source };
};

/**
 * Convenience wrapper: resolve, and throw a caller-friendly error when the user
 * genuinely has no usable signer. Use where a missing key is fatal.
 */
const requireActorKey = async (params) => {
  const resolved = await resolveActorKey(params);
  if (!resolved.actorKey) {
    throw new AppError(
      `${params.label || "This account"} has no wallet key available for this action`,
      422,
      "NO_WALLET"
    );
  }
  return resolved;
};

/**
 * Which wallet will sign for a project, without loading keys - for display.
 * @returns {{ address: string|null, source: string|null, reason: string }}
 */
const describeActorFor = async ({ user, project = null, party = "client" } = {}) => {
  const onChainProjectId = project?.onChainProjectId;
  const onChainParty = onChainProjectId
    ? await readOnChainParty({ onChainProjectId, party })
    : null;

  if (onChainParty) {
    const match = keyForAddress(user, onChainParty, party);
    if (match) {
      return {
        address: match.address,
        source: match.source,
        reason: "on-chain client record",
      };
    }
    return { address: null, source: null, reason: "on-chain address has no stored key" };
  }

  const preferred = preferredCandidate(user);
  return {
    address: preferred?.address || null,
    source: preferred?.source || null,
    reason: onChainProjectId ? "chain unavailable, using preference" : "new project",
  };
};

module.exports = {
  resolveActorKey,
  requireActorKey,
  describeActorFor,
  listCandidateWallets,
  norm,
};