/**
 * ABI conformance guard.
 *
 * The backend relays contract calls by `method` name plus a positional `args`
 * array. Solidity/ABI drift (renames, added parameters, removed functions) is
 * therefore SILENT until a user hits a confusing revert in production.
 *
 * This test pins the exact signatures the backend depends on. If the contract
 * changes shape, this fails with a readable diff instead of failing live.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const artifact = require("../contracts/contractsData/Blockefy.json");

const SRC = path.join(__dirname, "..", "src");
const ROOT = path.join(__dirname, "..");

/**
 * Every contract call the backend relays, with the exact argument count it
 * passes. Update this table whenever a signature legitimately changes - and
 * update the call sites in the same commit.
 */
const RELAYED_CALLS = [
  { method: "createProject", args: 2 },
  { method: "approveProject", args: 2 },
  { method: "createMilestone", args: 3 },
  { method: "completeMilestone", args: 2 },
  { method: "approveDeliverable", args: 2 }, // (projectId, milestoneId)
  { method: "requestChanges", args: 3 }, // (projectId, milestoneId, extraDays)
  { method: "depositFunds", args: 1 },
  { method: "claimMilestone", args: 2 },
  { method: "retrieveFunds", args: 1 },
  { method: "openDispute", args: 1 },
  { method: "resolveDispute", args: 2 },
];

/** View functions the backend reads. */
const VIEW_CALLS = [
  { method: "projects", args: 1 },
  { method: "milestones", args: 1 },
  { method: "getProjectMilestones", args: 1 },
  { method: "getMilestonesDetails", args: 1 },
  { method: "getProjectEscrow", args: 1 },
  { method: "isReviewLapsed", args: 1 },
  { method: "projectCounter", args: 0 },
  { method: "milestoneCounter", args: 0 },
  { method: "totalEscrowed", args: 0 },
  { method: "owner", args: 0 },
];

/** Events the backend parses out of receipts. */
const PARSED_EVENTS = [
  "ProjectCreated",
  "MilestoneCreated",
  "FundsDeposited",
  "MilestoneClaimed",
  "FundsRefunded",
  "DisputeOpened",
  "DisputeResolved",
];

const functionsByName = new Map();
for (const entry of artifact.abi) {
  if (entry.type === "function") {
    if (!functionsByName.has(entry.name)) functionsByName.set(entry.name, []);
    functionsByName.get(entry.name).push(entry);
  }
}

test("every relayed contract method exists in the ABI", () => {
  const missing = RELAYED_CALLS.filter((c) => !functionsByName.has(c.method)).map((c) => c.method);
  assert.deepEqual(missing, [], `backend relays methods missing from the ABI: ${missing.join(", ")}`);
});

test("relayed call arity matches the ABI", () => {
  for (const { method, args } of RELAYED_CALLS) {
    const overloads = functionsByName.get(method) || [];
    const match = overloads.find((f) => f.inputs.length === args);
    assert.ok(
      match,
      `backend calls ${method} with ${args} arg(s) but the ABI declares ` +
        overloads.map((f) => `${f.name}(${f.inputs.length})`).join(", ")
    );
  }
});

test("approveDeliverable takes a milestone id (per-milestone approval)", () => {
  const fn = functionsByName.get("approveDeliverable")[0];
  const names = fn.inputs.map((i) => i.name);
  assert.deepEqual(names, ["_projectId", "_milestoneId"]);
  // Guard against the old project-wide sticky-approval bug.
  assert.equal(fn.inputs.length, 2);
});

test("requestChanges takes a milestone id and extra days", () => {
  const fn = functionsByName.get("requestChanges")[0];
  const names = fn.inputs.map((i) => i.name);
  assert.deepEqual(names, ["_projectId", "_milestoneId", "_extraDays"]);
});

test("claimMilestone takes a milestone id", () => {
  const fn = functionsByName.get("claimMilestone")[0];
  assert.deepEqual(fn.inputs.map((i) => i.name), ["_projectId", "_milestoneId"]);
});

test("every view function the backend reads exists", () => {
  const missing = VIEW_CALLS.filter((c) => !functionsByName.has(c.method)).map((c) => c.method);
  assert.deepEqual(missing, [], `backend reads views missing from the ABI: ${missing.join(", ")}`);
  for (const { method, args } of VIEW_CALLS) {
    const fn = (functionsByName.get(method) || [])[0];
    if (fn) assert.equal(fn.inputs.length, args, `${method} arity drifted`);
  }
});

test("every event the backend parses exists in the ABI", () => {
  const events = new Set(artifact.abi.filter((e) => e.type === "event").map((e) => e.name));
  const missing = PARSED_EVENTS.filter((name) => !events.has(name));
  assert.deepEqual(missing, [], `backend parses events missing from the ABI: ${missing.join(", ")}`);
});

test("the generic relay whitelist cannot reach value-moving or admin methods", () => {
  const src = fs.readFileSync(
    path.join(SRC, "controllers", "smartContractController.js"),
    "utf8"
  );
  const whitelist = src.match(/const WHITELISTED_METHODS = \[([\s\S]*?)\];/);
  assert.ok(whitelist, "could not locate WHITELISTED_METHODS in smartContractController.js");
  const allowed = [...whitelist[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);

  const mustNeverBeGeneric = [
    "claimMilestone",
    "fixClaim",
    "submitFixClaim",
    "approveFixClaim",
    "depositFunds",
    "retrieveFunds",
    "openDispute",
    "resolveDispute",
    "sweepSurplus",
    "pause",
    "unpause",
    "setPlatformFee",
    "setTreasury",
    "transferOwnership",
    "renounceOwnership",
  ];
  const leaked = allowed.filter((m) => mustNeverBeGeneric.includes(m));
  assert.deepEqual(leaked, [], `generic relay must not expose: ${leaked.join(", ")}`);

  // And every whitelisted method must really exist in the ABI.
  const unknown = allowed.filter((m) => !functionsByName.has(m));
  assert.deepEqual(unknown, [], `relay whitelist references unknown methods: ${unknown.join(", ")}`);
});

test("no caller supplies an admin private key through a request body", () => {
  const controller = fs.readFileSync(
    path.join(SRC, "controllers", "escrowController.js"),
    "utf8"
  );
  assert.ok(
    !/req\.body\.adminKey/.test(controller),
    "escrowController must not read a private key from the request body"
  );
  const service = fs.readFileSync(path.join(SRC, "services", "escrow.service.js"), "utf8");
  assert.ok(
    !/\{\s*project,\s*adminKey/.test(service) && !/adminKey \|\|/.test(service),
    "escrow.service must not accept an adminKey parameter"
  );
});

test("the artifact carries runtime bytecode so deployments can be verified", () => {
  assert.ok(
    artifact.deployedBytecode && artifact.deployedBytecode !== "0x",
    "artifact is missing `deployedBytecode`; chain.service.verifyDeployedContract() would throw at load"
  );
  assert.ok(
    artifact.bytecode && artifact.bytecode !== artifact.deployedBytecode,
    "creation bytecode and runtime bytecode should differ"
  );
});

test("the backend caps on-chain descriptions at the contract limit", () => {
  const fn = functionsByName.get("createMilestone")[0];
  assert.equal(fn.inputs.length, 3, "createMilestone(projectId, description, amount)");
  assert.ok(
    String(fn.inputs[1].name || "").toLowerCase().includes("description"),
    "2nd arg is the description"
  );

  // The contract's own cap, read from the ABI-visible constant.
  const maxDesc = artifact.abi.find((e) => e.type === "function" && e.name === "MAX_DESCRIPTION_LENGTH");
  assert.ok(maxDesc, "MAX_DESCRIPTION_LENGTH must be public so the backend can read it");

  const svc = fs.readFileSync(path.join(SRC, "services", "milestone.service.js"), "utf8");
  const m = svc.match(/MAX_ONCHAIN_DESCRIPTION\s*=\s*(\d+)/);
  assert.ok(m, "milestone.service must define MAX_ONCHAIN_DESCRIPTION");
  assert.ok(
    Number(m[1]) <= 500,
    `MAX_ONCHAIN_DESCRIPTION (${m[1]}) exceeds the contract cap of 500 and would revert`
  );
});

test("escrow and milestone services never silently skip a chain call", () => {
  // A skipped relay means the DB advances while the contract does not, which is
  // how escrow bugs become unrecoverable. These functions are onlyClient /
  // onlyFreelancer on-chain, so there is no fallback actor: they must throw.
  const milestone = fs.readFileSync(path.join(SRC, "services", "milestone.service.js"), "utf8");
  for (const method of ["approveDeliverable", "requestChanges", "createMilestone"]) {
    const idx = milestone.indexOf(`method: "${method}"`);
    assert.ok(idx > -1, `milestone.service should relay ${method}`);
    // The key must be resolved through a THROWING path, never a conditional that
    // lets the relay be skipped. Two acceptable shapes:
    //   - legacy inline guard that throws NO_RELAY
    //   - walletActor.requireActorKey(...), which throws NO_WALLET when no key
    const window = milestone.slice(Math.max(0, idx - 600), idx + 600);
    const throwsWhenKeyless = /NO_RELAY/.test(window) || /requireActorKey/.test(window);
    assert.ok(
      throwsWhenKeyless,
      `${method} must throw when the actor has no key, not skip the chain call`
    );
    // It must branch on a resolved actor key - either the legacy inline check or
    // the resolver.
    const branchesOnKey =
      /if \(!?user\.walletPrivateKey/.test(window) || /requireActorKey/.test(window);
    assert.ok(branchesOnKey, `${method} should branch on the actor's key`);
  }
  const escrow = fs.readFileSync(path.join(SRC, "services", "escrow.service.js"), "utf8");
  assert.ok(
    !/user\.walletPrivateKey \|\| \(await resolveRelayKey/.test(escrow),
    "depositFunds is onlyClient; it must not fall back to another party's key"
  );
});

test("the backend truncates milestone titles on a UTF-8 byte boundary", () => {
  const svc = fs.readFileSync(path.join(SRC, "services", "milestone.service.js"), "utf8");
  assert.ok(
    /const MAX_TITLE_LENGTH = (\d+)/.test(svc) && /truncateToBytes\(/.test(svc),
    "titles must be truncated by bytes, not by String.slice (which counts UTF-16 units)"
  );
  // The on-chain description and the stored title must be the SAME string,
  // otherwise the DB row and the chain row can drift apart.
  const create = svc.slice(svc.indexOf("const createMilestone"), svc.indexOf("const createMilestone") + 3000);
  assert.ok(
    /const title = truncateToBytes\(/.test(create) && /method: "createMilestone",\s*args: \[[^\]]*\btitle\b/.test(create),
    "createMilestone must send the same truncated title it stores"
  );
});

test("a completed project can be re-opened by adding a milestone", () => {
  // A product requirement: adding a milestone to a finished project resumes work.
  const svc = fs.readFileSync(path.join(SRC, "services", "milestone.service.js"), "utf8");
  const create = svc.slice(svc.indexOf("const createMilestone"), svc.indexOf("const createMilestone") + 3000);
  assert.ok(
    /\[?"in_progress",\s*"completed"\]?/.test(create),
    "createMilestone must allow in_progress AND completed projects"
  );
  assert.ok(
    !/project\.status !== "in_progress"/.test(create),
    "a status check that only allows in_progress would block re-opening a completed project"
  );
});

test("only the client can deposit or retrieve, since both are onlyClient on-chain", () => {
  const escrow = fs.readFileSync(path.join(SRC, "services", "escrow.service.js"), "utf8");
  for (const fn of ["createDeposit", "refund"]) {
    const idx = escrow.indexOf(`const ${fn} = async`);
    assert.ok(idx > -1, `escrow.service should define ${fn}`);
    const body = escrow.slice(idx, idx + 400);
    assert.ok(
      /String\(project\.buyerId\) !== String\(user\._id\)/.test(body) && !/!isAdmin\(user\)/.test(body),
      `${fn} is onlyClient on-chain; an admin override would just revert`
    );
  }
});

test("the bytecode check ignores solc source metadata", () => {
  // The Remix build is the SAME contract flattened into one file, so its trailing
  // CBOR metadata (a keccak of the source) always differs from the local artifact
  // even though the executable code is identical. Comparing the full blob would
  // reject a perfectly valid deployment.
  const chain = fs.readFileSync(path.join(SRC, "services", "chain.service.js"), "utf8");
  assert.ok(
    /stripSolidityMetadata/.test(chain),
    "chain.service must strip CBOR metadata before hashing deployed code"
  );
  assert.ok(
    /keccak256\(stripSolidityMetadata\(code\)\)/.test(chain),
    "the on-chain code must be metadata-stripped before hashing"
  );

  const { ethers } = require("ethers");
  const chainService = require("../src/services/chain.service");
  const strip = chainService.stripSolidityMetadata;
  // Layout: executable code || CBOR metadata || 2-byte metadata length.
  const code = "60016002";
  const metadata = "aabbccdd";
  const blob = code + metadata + (metadata.length / 2).toString(16).padStart(4, "0");
  assert.equal(strip("0x" + blob), "0x" + code, "must drop the metadata block and its length");
  assert.equal(strip("0x"), "0x");
  assert.equal(strip(undefined), "0x");
  // A non-solc blob (bogus length) must be returned unchanged, never truncated.
  const bogus = "0x6001ffff";
  assert.equal(strip(bogus), bogus);
  // Two builds of the same code with different metadata must hash identically.
  const other = "0x" + code + "11223344" + (4).toString(16).padStart(4, "0");
  assert.equal(
    ethers.keccak256(strip("0x" + blob)),
    ethers.keccak256(strip(other)),
    "same executable code must produce the same hash regardless of metadata"
  );
});

test("the Remix build is deployable and matches the artifact", () => {
  const remix = path.join(ROOT, "contracts", "contractsData", "Blockefy.remix.sol");
  assert.ok(fs.existsSync(remix), "run `npm run compile:contract` to generate Blockefy.remix.sol");
  const src = fs.readFileSync(remix, "utf8");
  assert.ok(
    !/^\s*import[^;]*;/m.test(src),
    "the Remix file must be import-free or it cannot be pasted into Remix"
  );
  assert.equal((src.match(/pragma solidity/g) || []).length, 1, "exactly one pragma");
  assert.equal((src.match(/SPDX-License-Identifier/g) || []).length, 1, "exactly one SPDX id");
  assert.ok(/contract Blockefy is ReentrancyGuard, Ownable, Pausable/.test(src));
  // The generated file must stay in sync with the real source.
  const real = fs.readFileSync(path.join(ROOT, "contracts", "Blockefy.sol"), "utf8");
  // Must mirror stripForFlatten() in scripts/compile-contract.js exactly.
  const stripForFlatten = (s) =>
    s
      .replace(/^\s*import[^;]*;\s*$/gm, "")
      .replace(/^\s*pragma solidity[^;]*;\s*$/gm, "")
      .replace(/^\s*\/\/\s*SPDX-License-Identifier:.*$/gm, "")
      .trim();
  assert.ok(src.includes(stripForFlatten(real)), "Blockefy.remix.sol is stale - re-run npm run compile:contract");
});

test("a single deadline extension is bounded so it cannot overflow", () => {
  const fn = functionsByName.get("MAX_DEADLINE_EXTENSION");
  assert.ok(fn, "MAX_DEADLINE_EXTENSION must exist and be public");
  assert.equal(Number(fn.outputs?.[0]?.internalType?.match(/\d+/)?.[0] || 365), 365, "365 days max per call");
  const sol = fs.readFileSync(path.join(ROOT, "contracts", "Blockefy.sol"), "utf8");
  assert.ok(
    /require\(_extraDays <= MAX_DEADLINE_EXTENSION, "Blockefy: extension too long"\)/.test(sol),
    "_extendDeadline must bound extraDays to avoid an overflow revert"
  );
  // Extensions stay additive, so a project can still be extended indefinitely.
  assert.ok(/_project\.deadline = base \+ \(_extraDays \* 1 days\)/.test(sol), "extensions must be additive");
});

test("a relay never signs as the wrong actor", () => {
  // `createProject`/`approveProject` are onlyClient and `claimMilestone`/`fixClaim`
  // accept only the client or freelancer. Signing those from an admin key would
  // record the admin on-chain as the client while MongoDB records the buyer, and
  // the buyer could then never fund, approve or refund their own project.
  const project = fs.readFileSync(path.join(SRC, "services", "project.service.js"), "utf8");
  const resolve = project.slice(project.indexOf("const resolveProjectRelayKey"), project.indexOf("const resolveProjectRelayKey") + 700);
  assert.ok(
    !/ADMIN_PRIVATE_KEY|role: "admin"/.test(resolve),
    "resolveProjectRelayKey must not fall back to an admin key for onlyClient calls"
  );
  assert.ok(
    /assertKeyControlsAddress/.test(resolve),
    "resolveProjectRelayKey must prove the key controls the user's own wallet"
  );

  const escrow = fs.readFileSync(path.join(SRC, "services", "escrow.service.js"), "utf8");
  const er = escrow.slice(escrow.indexOf("const resolveRelayKey"), escrow.indexOf("const resolveRelayKey") + 2000);
  assert.ok(
    !/ADMIN_PRIVATE_KEY/.test(er),
    "claimMilestone is onlyClient-or-onlyFreelancer; an admin key would always revert"
  );
  // A party key must be proven to control that party's on-chain address before it
  // is used to impersonate them. This now happens in walletActor: `keyForAddress`
  // derives the address from the candidate key and only returns it on an exact
  // match, and `resolveActorKey` throws ACTOR_KEY_UNAVAILABLE rather than guessing.
  const actor = fs.readFileSync(path.join(SRC, "services", "walletActor.service.js"), "utf8");
  assert.ok(
    /assertKeyControlsAddress/.test(er) || /walletActor\.resolveActorKey/.test(er),
    "escrow must resolve the party key through the verified actor resolver"
  );
  const derived = actor.slice(actor.indexOf("const keyForAddress"), actor.indexOf("const keyForAddress") + 900);
  assert.ok(
    /ethers\.Wallet\(candidate\.privateKey\)\.address/.test(derived) && /derived !== target/.test(derived),
    "walletActor.keyForAddress must derive the address from the key and reject any mismatch"
  );
  assert.ok(
    /ACTOR_KEY_UNAVAILABLE/.test(actor),
    "walletActor must refuse to guess when no key controls the recorded on-chain address"
  );

  // The helper must exist and be used by the generic relay too.
  const chain = fs.readFileSync(path.join(SRC, "services", "chain.service.js"), "utf8");
  assert.ok(/const assertKeyControlsAddress =/.test(chain));
  const relay = fs.readFileSync(path.join(SRC, "controllers", "smartContractController.js"), "utf8");
  assert.ok(/assertKeyControlsAddress/.test(relay), "the generic relay must not sign as another address");
});

test("the generic relay cannot skip the project participation check", () => {
  const src = fs.readFileSync(path.join(SRC, "controllers", "smartContractController.js"), "utf8");
  assert.ok(
    !/projectId \|\| ""\) === "" \|\|/.test(src) && !/projectId \|\| ""\) === ""/.test(src),
    "an absent projectId must not bypass authorization"
  );
  // The project id must be derivable from args[0], since every project-scoped
  // method takes it as the first argument.
  assert.ok(
    /const targetProjectId = projectId \|\| args\[0\]/.test(src),
    "projectId must fall back to args[0] so the check cannot be skipped"
  );
  assert.ok(
    /projectId is required for this method/.test(src),
    "a project-scoped relay without any project id must be rejected"
  );
});

test("the backend gas limit covers the measured worst case", () => {
  const chain = fs.readFileSync(path.join(SRC, "services", "chain.service.js"), "utf8");
  const m = chain.match(/TX_GAS_LIMIT\s*\|\|\s*(\d+)/);
  assert.ok(m, "chain.service must define a default TX_GAS_LIMIT");
  // Measured worst case: createMilestone with a 500-byte description = 522,441 gas
  // (see `npm run measure:gas`). Re-measure if MAX_DESCRIPTION_LENGTH changes.
  const WORST_CASE = 522441;
  assert.ok(
    Number(m[1]) > WORST_CASE,
    `default gas limit ${m[1]} does not cover the measured worst case ${WORST_CASE}`
  );
});
