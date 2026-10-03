# Deploying Blockefy.sol to BNB Smart Chain Testnet

The contract lives at `contracts/Blockefy.sol`. The same source compiles locally
(`npm run compile:contract`) and is what gets deployed, so the backend and the
chain can never disagree.

## Status: DEPLOYED and VERIFIED

| | |
| --- | --- |
| Address | `0x1247aB375f9C2451B681Cd3c13c42Fc518Eb5458` |
| Network | BNB Smart Chain Testnet, chain id 97 |
| Owner / treasury | `0x228d3654bd50C9D97931d43707181BBb6C46a7c3` |
| Runtime bytecode | 15,590 bytes (15,537 executable) |
| Bytecode check | **PASS** — on-chain code matches `Blockefy.json` |
| `projectCounter` / `milestoneCounter` | 0 / 0 at verification time |
| `totalEscrowed` | 0 BNB |
| Explorer | <https://testnet.bscscan.com/address/0x1247aB375f9C2451B681Cd3c13c42Fc518Eb5458> |

The deployment was confirmed by recompiling `Blockefy.sol` locally with
viaIR + runs 200 + shanghai and getting a **byte-identical** executable
bytecode. Confirmed live: `owner()`, `treasury()`, all counters, all constants
(`MAX_DESCRIPTION_LENGTH` 500, `MAX_DEADLINE_EXTENSION` 365,
`DEFAULT_REVIEW_WINDOW` 15 days), and the custom revert strings.

> If `Blockefy.json` is ever regenerated and the guard reports
> `CONTRACT_MISMATCH`, run `npm run compile:contract` - the artifact, not the
> deployment, is what went stale.

## 0. Use the generated single file

`npm run compile:contract` writes **`contracts/contractsData/Blockefy.remix.sol`** —
the whole contract with OpenZeppelin v5 inlined and every `import` removed. It is
generated from `Blockefy.sol`, so it is always in sync.

**Paste that file into Remix.** Do not paste `Blockefy.sol`: it imports
`@openzeppelin/contracts/...`, which Remix cannot resolve unless you also add the
OpenZeppelin package to the workspace.

```bash
npm run compile:contract   # writes Blockefy.json + Blockefy.remix.sol
npm run verify:remix       # proves the pasted file matches the artifact
```

`verify:remix` compiles the flattened file stand-alone and checks the executable
bytecode and ABI against `Blockefy.json`. It must pass **before** you deploy.

Verified current build (solc `0.8.24`, optimizer on, runs 200, viaIR, shanghai):

| | |
| --- | --- |
| ABI entries | 65 |
| Creation bytecode | 15,920 bytes |
| Runtime bytecode | 15,590 bytes (15,537 executable) |
| Runtime keccak256 (metadata stripped) | `0x9708f5b69b856583319f5f509cf34b6d73ca9795b1b35d3cec341ba6c31f7b25` |

Runtime is well under the 24,576-byte EIP-170 limit.

> The backend compares the **metadata-stripped** runtime code. Solc appends a CBOR
> block holding a hash of the source, and the flattened file is a different source,
> so that hash always differs from a multi-file build even though the executable
> code is identical. Comparing the full blob would reject a valid deployment, so
> `chain.service.stripSolidityMetadata()` removes it before hashing.

## 1. Compiler settings (Remix)

| Setting | Value |
| --- | --- |
| Solidity compiler | `0.8.24` |
| EVM version | `shanghai` |
| Enable optimization | **on** |
| Runs | `200` |
| **Enable `viaIR`** | **on** — required, the contract hits "stack too deep" without it |

If you change any of these, the executable code changes and the backend will
reject the deployment with `CONTRACT_MISMATCH`. Re-run `npm run compile:contract`
on this machine to confirm.


## 2. Constructor argument

There is exactly one:

```solidity
constructor(address _treasury)
```

Pass your **funded account's address** (the same account whose key goes in
`ADMIN_PRIVATE_KEY`). It receives platform fees. The account you deploy from
becomes the contract `owner` (admin) automatically via OpenZeppelin `Ownable`.

Steps:
1. Create/import a funded BNB Testnet account (faucet: <https://www.bnbchain.org/en/testnetFaucet>).
2. Fund it with ~`0.5 BNB`.
3. In Remix, set that account in the injected provider (MetaMask) and switch to
   **BNB Smart Chain Testnet**.

## 3. Deploy

1. Open `contracts/contractsData/Blockefy.remix.sol` in Remix, compile with the
   settings above.
2. **Deploy & Run Transactions** → environment **Injected Provider - BNB Smart Chain Testnet**.
3. Set `treasury` to the funded account address → **Deploy**.
   (Enable "contract creation code" in the contract dropdown if you want to
   verify the bytecode matches the local artifact.)
4. Copy the deployed contract address.

There is exactly one constructor argument, `address _treasury`. The account you
deploy from automatically becomes the contract `owner` (admin) via OpenZeppelin
`Ownable`, and that is the address `ADMIN_PRIVATE_KEY` must resolve to.

## 4. Point the backend at it

```dotenv
# .env
RPC_URL=https://data-seed-prebsc-1-s1.bnbchain.org:8545
# RPC_URLS=https://data-seed-prebsc-1-s1.bnbchain.org:8545,https://bsc-testnet-rpc.publicnode.com
CHAIN_ID=97
CONTRACT_ADDRESS=0x<deployed address>
TX_CONFIRMATIONS=1
TX_GAS_LIMIT=900000

# Must be the account that DEPLOYED the contract, and must hold BNB for gas.
ADMIN_PRIVATE_KEY=0x<funded account private key>

AUTO_RELEASE_ESCROW=false
```

Also update the fallback address file:

```jsonc
// contracts/contractsData/Blockefy-address.json
{ "address": "0x<deployed address>" }
```

`CONTRACT_ADDRESS` wins over the address file, so set it explicitly.

**Never commit the private key.** It stays in `.env` only.

## 5. Verify before touching real flows

```bash
npm run compile:contract     # must match what you deployed
```

Then hit the health endpoint:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:7980/api/contract/status
```

Confirm:

```json
{
  "chainId": 97,
  "contractAddress": "0x<deployed address>",
  "contractDeployed": true,
  "contractOwner": "0x<funded account>",
  "projectCounter": 0,
  "milestoneCounter": 0
}
```

- `contractDeployed: false` → the address does not hold the compiled contract.
  Redeploy or fix `CONTRACT_ADDRESS`. This check runs on **every** relay, so a
  stale address fails fast with `CONTRACT_MISMATCH` instead of a mystery revert.
- `contractOwner` must equal the `ADMIN_PRIVATE_KEY` address, otherwise
  `resolveDispute` will be rejected.

## 6. Contract behaviour reference

| Function | Caller | Notes |
| --- | --- | --- |
| `createProject(type, metadataHash)` | client | `0` = FixClaim, `1` = Milestones |
| `approveProject(projectId, freelancer)` | client | once only, not self, not zero |
| `createMilestone(projectId, description, amount)` | freelancer | any time; re-opens a completed project; description ≤ 500 bytes |
| `depositFunds(projectId)` | client | value must **exactly** equal the next unfunded milestone |
| `completeMilestone(projectId, milestoneId)` | freelancer | opens the review window |
| `approveDeliverable(projectId, milestoneId)` | client | per-milestone; never unlocks another milestone |
| `requestChanges(projectId, milestoneId, extraDays)` | client | re-opens for rework, **extends** the deadline |
| `extendDeadline(projectId, extraDays)` | client | additive; never shortens; `extraDays` ≤ 365 per call |
| `claimMilestone(projectId, milestoneId)` | client or freelancer | strictly sequential; also fires automatically once the review window lapses |
| `submitFixClaim` / `approveFixClaim` / `fixClaim` | freelancer / client / either | FixClaim flow |
| `retrieveFunds(projectId)` | client | after the deadline, and never while a deliverable is under review |
| `openDispute` / `resolveDispute` | either party / owner | `resolveDispute` is `onlyOwner` |
| `sweepSurplus(to)` | owner | can never touch `totalEscrowed` |

## 7. Gas

Measured with `npm run measure:gas` against a real deployment:

| Path | gasUsed |
| --- | --- |
| `createMilestone` (500-byte description) | 522,441 |
| `openDispute` / `resolveDispute` (15 milestones) | ~180,000 |
| `createProject` | ~180,000 |
| `depositFunds` | ~138,000 |
| `claimMilestone` (with payout) | ~96,000 |
| `completeMilestone` | ~71,000 |
| `approveDeliverable` | ~50,000 |

`TX_GAS_LIMIT=900000` leaves ~70% headroom. If you change
`MAX_DESCRIPTION_LENGTH`, re-run `npm run measure:gas` and update it.

## 8. End-to-end smoke test

```bash
npm test                    # 159 tests: contract lifecycle, ABI conformance, services
npm run jobs                # one-shot job run (auto-release is opt-in)
```

### Live escrow test against the deployed contract

`npm run e2e:live` moves real testnet BNB through the whole flow and asserts the
escrow accounting, role enforcement, exact-amount deposits, sequential claiming
and the recipient's balance delta:

```
createProject -> approveProject -> createMilestone x2 -> depositFunds
-> completeMilestone -> approveDeliverable -> claimMilestone
-> requestChanges (rework) -> resubmit -> claim
-> reopen a completed project -> openDispute -> resolveDispute
```

It needs two **different** accounts funded with testnet BNB in `.env`:

```dotenv
E2E_CLIENT_PRIVATE_KEY=0x...      # the owner account is ideal
E2E_FREELANCER_PRIVATE_KEY=0x...
```

Faucet: <https://www.bnbchain.org/en/testnetFaucet>

It pre-flights first (chain id, bytecode match, balances) and exits with a clear
message rather than sending transactions it cannot afford. Only the
`resolveDispute` step needs the client to be the contract owner; it is skipped
with a notice otherwise.

Then, in the app: create a project as the funded client → invite/accept a
proposal as the freelancer → freelancer adds a milestone → client deposits →
freelancer submits work → client approves → payment is released.

Watch the same flow on the explorer:
<https://testnet.bscscan.com/address/<deployed address>>
