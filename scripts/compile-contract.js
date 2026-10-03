/**
 * Compiles contracts/Blockefy.sol and emits two artifacts:
 *
 *  1. contracts/contractsData/Blockefy.json  - Hardhat-style artifact consumed by
 *     the backend (chain.service reads .abi and .deployedBytecode).
 *  2. contracts/contractsData/Blockefy.remix.sol - a single, IMPORT-FREE source
 *     file with the OpenZeppelin sources inlined, ready to paste into Remix.
 *
 * Usage: node scripts/compile-contract.js
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_FILE = "contracts/Blockefy.sol";
const OUT_DIR = path.join(ROOT, "contracts", "contractsData");
const OUT_FILE = path.join(OUT_DIR, "Blockefy.json");
const OUT_REMIX_FILE = path.join(OUT_DIR, "Blockefy.remix.sol");

const OPTIMIZER = { enabled: true, runs: 200 };

/**
 * Resolves a Solidity import path. Relative paths (`../utils/Context.sol`) are
 * resolved against the file that contains the import; bare/npm paths are
 * resolved against the project root and node_modules.
 */
function resolveImport(importPath, fromFile) {
  const candidates = [];
  if (importPath.startsWith(".") && fromFile) {
    const base = path.dirname(fromFile);
    candidates.push(path.resolve(path.join(ROOT, base), importPath));
  } else {
    candidates.push(path.join(ROOT, importPath));
    candidates.push(path.join(ROOT, "node_modules", importPath));
  }
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p, "utf8");
  }
  return null;
}

const input = {
  language: "Solidity",
  sources: { [SOURCE_FILE]: { content: fs.readFileSync(path.join(ROOT, SOURCE_FILE), "utf8") } },
  settings: {
    optimizer: OPTIMIZER,
    viaIR: true,
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(
  solc.compile(JSON.stringify(input), {
    import: (importPath) => {
      const contents = resolveImport(importPath, SOURCE_FILE);
      return contents ? { contents } : { error: `File not found: ${importPath}` };
    },
  })
);

const errors = (output.errors || []).filter((e) => e.severity === "error");
const warnings = (output.errors || []).filter((e) => e.severity === "warning");
if (warnings.length) {
  console.log(`[compile] ${warnings.length} warning(s)`);
  for (const w of warnings.slice(0, 12)) {
    console.log("  -", (w.formattedMessage || w.message).trim().split("\n")[0]);
  }
}
if (errors.length) {
  console.error(`[compile] FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error((e.formattedMessage || e.message).trim());
  process.exit(1);
}

const compiled = output.contracts?.[SOURCE_FILE]?.Blockefy;
if (!compiled) {
  console.error("[compile] Blockefy not found in compiler output");
  process.exit(1);
}

const artifact = {
  _format: "hh-sol-artifact-1",
  contractName: "Blockefy",
  sourceName: SOURCE_FILE,
  abi: compiled.abi,
  bytecode: "0x" + compiled.evm.bytecode.object,
  deployedBytecode: "0x" + compiled.evm.deployedBytecode.object,
  linkReferences: {},
  deployedLinkReferences: {},
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Remix-friendly single file: resolve the full transitive OpenZeppelin import
// graph, order it topologically (Solidity requires a base contract to be
// declared before anything inheriting from it), strip every import, and emit one
// self-contained file. `scripts/verify-remix-build.js` proves the result compiles
// stand-alone and produces byte-identical output.
// ---------------------------------------------------------------------------

/** Collects a source and everything it imports, transitively. */
function collectSources(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    const contents = resolveImport(current);
    if (contents === null) {
      console.warn(`[compile] skipping unresolved source: ${current}`);
      continue;
    }
    seen.add(current);
    const importRe = /^\s*import\s+(?:[^"';]*from\s*)?["']([^"']+)["']\s*;/gm;
    let m;
    while ((m = importRe.exec(contents)) !== null) {
      // Normalise relative paths to project-relative ones so the graph has a
      // single key per file and the topo sort can match on it.
      const resolved = m[1].startsWith(".") ? path.normalize(path.join(path.dirname(current), m[1])) : m[1];
      if (!seen.has(resolved)) stack.push(resolved);
    }
  }
  return [...seen];
}

/**
 * Prepares a source for inlining: drops its imports, its pragma and its SPDX id,
 * so the flattened file has exactly one of each.
 */
const stripForFlatten = (src) =>
  src
    .replace(/^\s*import[^;]*;\s*$/gm, "")
    .replace(/^\s*pragma solidity[^;]*;\s*$/gm, "")
    .replace(/^\s*\/\/\s*SPDX-License-Identifier:.*$/gm, "")
    .trim();

/** Orders sources so every contract/interface is declared before its users. */
function topoSortSources(files) {
  const graph = new Map();
  for (const file of files) {
    const contents = resolveImport(file);
    const deps = new Set();
    const importRe = /^\s*import\s+(?:[^"';]*from\s*)?["']([^"']+)["']\s*;/gm;
    let m;
    while ((m = importRe.exec(contents)) !== null) {
      const resolved = m[1].startsWith(".") ? path.normalize(path.join(path.dirname(file), m[1])) : m[1];
      if (files.includes(resolved)) deps.add(resolved);
    }
    graph.set(file, deps);
  }

  const ordered = [];
  const state = new Map(); // file -> "visiting" | "done"
  const visit = (file, stack) => {
    if (state.get(file) === "done") return;
    if (state.get(file) === "visiting") {
      throw new Error(`Circular import detected: ${[...stack, file].join(" -> ")}`);
    }
    state.set(file, "visiting");
    for (const dep of graph.get(file) || []) visit(dep, [...stack, file]);
    state.set(file, "done");
    ordered.push(file);
  };
  for (const file of files) visit(file, []);
  return ordered;
}

const ozFiles = topoSortSources(collectSources(SOURCE_FILE));
const ozBlocks = ozFiles
  .filter((f) => f !== SOURCE_FILE)
  .map((f) => `// ===== ${f.replace("node_modules/@openzeppelin/contracts/", "openzeppelin/")} =====\n${stripForFlatten(resolveImport(f))}`);

const blockefySource = fs.readFileSync(path.join(ROOT, SOURCE_FILE), "utf8");
const blockefyPragma = (blockefySource.match(/^pragma solidity[^;]*;/m) || ["pragma solidity ^0.8.20;"])[0];

// Solidity requires a base contract to be declared BEFORE any contract that
// inherits from it, so the OpenZeppelin sources come first and Blockefy last.
const remixFile = `// SPDX-License-Identifier: MIT
${blockefyPragma}

/**
 * Blockefy - single-file build for Remix.
 *
 * AUTO-GENERATED by scripts/compile-contract.js from contracts/Blockefy.sol with
 * the OpenZeppelin v5 sources inlined. Do not edit here: edit Blockefy.sol and
 * re-run \`npm run compile:contract\`.
 *
 * Remix compiler settings (MUST match, or the deployed bytecode will differ and
 * the backend's bytecode check will reject it):
 *   - Solidity 0.8.x (^0.8.20)
 *   - EVM version: shanghai
 *   - Enable optimization: YES
 *   - Runs: 200
 *   - Enable viaIR: YES
 *
 * Verify with: npm run verify:remix
 */

${ozBlocks.join("\n\n")}

// ===== contracts/Blockefy.sol =====

${stripForFlatten(blockefySource)}
`;

fs.writeFileSync(OUT_REMIX_FILE, remixFile);

const creation = (artifact.bytecode.length - 2) / 2;
const runtime = (artifact.deployedBytecode.length - 2) / 2;
console.log(`[compile] OK -> ${path.relative(ROOT, OUT_FILE)}`);
console.log(`[compile] OK -> ${path.relative(ROOT, OUT_REMIX_FILE)}`);
console.log(`[compile] abi entries: ${artifact.abi.length}`);
console.log(`[compile] creation bytecode: ${creation} bytes`);
console.log(`[compile] runtime bytecode:  ${runtime} bytes`);
if (runtime > 24576) {
  console.error("[compile] runtime exceeds the EIP-170 limit - contract will not deploy!");
  process.exit(1);
}
