/**
 * Proves the Remix single-file build is equivalent to contracts/Blockefy.sol:
 * compiles contracts/contractsData/Blockefy.remix.sol as a stand-alone file
 * (no imports allowed) and compares its runtime bytecode + ABI against the
 * artifact the backend verifies deployments with.
 *
 * If this ever diverges, the contract pasted into Remix would NOT match the
 * address the backend accepts, so it must fail loudly.
 *
 * Usage: node scripts/verify-remix-build.js
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const REMIX_FILE = "contracts/contractsData/Blockefy.remix.sol";
const ARTIFACT_FILE = path.join(ROOT, "contracts", "contractsData", "Blockefy.json");

const artifact = JSON.parse(fs.readFileSync(ARTIFACT_FILE, "utf8"));
const remixSource = fs.readFileSync(path.join(ROOT, REMIX_FILE), "utf8");

// The whole point of the flattened file is that it has no external imports.
const importLines = remixSource.match(/^\s*import[^;]*;/gm) || [];
if (importLines.length) {
  console.error(`[verify] ${REMIX_FILE} still has ${importLines.length} import(s) - it will not paste into Remix cleanly:`);
  for (const l of importLines) console.error("   ", l.trim());
  process.exit(1);
}

// Exactly one pragma and one SPDX id are required in a flattened file.
const pragmas = new Set((remixSource.match(/^pragma solidity[^;]*;/gm) || []).map((s) => s.trim()));
const spdx = (remixSource.match(/SPDX-License-Identifier:/g) || []).length;
if (pragmas.size !== 1) {
  console.error(`[verify] expected 1 pragma statement, found ${pragmas.size}`);
  process.exit(1);
}
if (spdx !== 1) {
  console.error(`[verify] expected 1 SPDX identifier, found ${spdx}`);
  process.exit(1);
}

const input = {
  language: "Solidity",
  sources: { [REMIX_FILE]: { content: remixSource } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(`[verify] ${REMIX_FILE} does NOT compile stand-alone (${errors.length} error(s)):`);
  for (const e of errors) console.error((e.formattedMessage || e.message).trim());
  process.exit(1);
}
const warnings = (output.errors || []).filter((e) => e.severity === "warning");
if (warnings.length) {
  console.log(`[verify] ${warnings.length} warning(s)`);
  for (const w of warnings.slice(0, 10)) {
    console.log("  -", (w.formattedMessage || w.message).trim().split("\n")[0]);
  }
}

const compiled = output.contracts?.[REMIX_FILE]?.Blockefy;
if (!compiled) {
  console.error("[verify] Blockefy not found when compiling the flattened source");
  process.exit(1);
}

const artifactRuntime = artifact.deployedBytecode.toLowerCase();
const remixRuntime = ("0x" + compiled.evm.deployedBytecode.object).toLowerCase();

/**
 * Removes the trailing CBOR metadata block (a keccak of the source + solc
 * settings). The flattened file has a different SOURCE, so its metadata hash
 * always differs - but the executable code must be byte-identical. The backend
 * applies the same strip before comparing (see chain.service.stripSolidityMetadata).
 */
const stripSolidityMetadata = (bytecode) => {
  const hex = bytecode.toLowerCase().replace(/^0x/, "");
  const metadataLength = parseInt(hex.slice(-4), 16);
  if (!Number.isFinite(metadataLength) || metadataLength * 2 + 4 > hex.length) return `0x${hex}`;
  return `0x${hex.slice(0, hex.length - 4 - metadataLength * 2)}`;
};

if (stripSolidityMetadata(artifactRuntime) !== stripSolidityMetadata(remixRuntime)) {
  console.error("[verify] RUNTIME BYTECODE MISMATCH (ignoring source metadata)");
  console.error(`  artifact: ${stripSolidityMetadata(artifactRuntime).length / 2 - 1} executable bytes`);
  console.error(`  remix   : ${stripSolidityMetadata(remixRuntime).length / 2 - 1} executable bytes`);
  console.error("  The contract you paste into Remix would NOT match the backend's bytecode check.");
  process.exit(1);
}

const artifactCreation = artifact.bytecode.toLowerCase();
const remixCreation = ("0x" + compiled.evm.bytecode.object).toLowerCase();
if (stripSolidityMetadata(artifactCreation) !== stripSolidityMetadata(remixCreation)) {
  console.error("[verify] CREATION BYTECODE MISMATCH (ignoring source metadata)");
  process.exit(1);
}

const norm = (abi) =>
  JSON.stringify(
    [...abi].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    (k, v) => (k === "internalType" ? undefined : v)
  );
if (norm(compiled.abi) !== norm(artifact.abi)) {
  console.error("[verify] ABI MISMATCH between the flattened source and the artifact");
  process.exit(1);
}

// The backend hashes the metadata-stripped code, so report that hash.
const codeOnly = stripSolidityMetadata(artifactRuntime);
console.log("[verify] OK - the Remix file is byte-identical to contracts/Blockefy.sol");
console.log(`[verify] abi entries:        ${artifact.abi.length}`);
console.log(`[verify] creation bytecode:  ${(artifactCreation.length - 2) / 2} bytes`);
console.log(`[verify] runtime bytecode:   ${(artifactRuntime.length - 2) / 2} bytes (${codeOnly.length / 2 - 1} executable)`);
console.log(`[verify] runtime keccak256:  ${keccak256(codeOnly)}`);
console.log(`[verify]   (metadata-stripped, this is what the backend compares)`);
console.log(`[verify] solc:               ${solc.version()}`);
console.log("[verify] paste Blockefy.remix.sol into Remix to deploy.");
