// TEMPORARY: boots a ganache node with the default mnemonic, deploys
// Blockefy.sol, prints the env needed to run the DB-backed integration tests,
// then stays alive until killed.
const { ethers } = require("ethers");
const ganache = require("ganache");
const artifact = require("../contracts/contractsData/Blockefy.json");

(async () => {
  // The DB-backed integration tests sign with the standard Hardhat keys, so the
  // local chain must expose exactly those accounts.
  const HARDHAT_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  ];
  const server = ganache.server({
    wallet: {
      accounts: HARDHAT_KEYS.map((secretKey) => ({ secretKey, balance: "0x21e19e0c9bab2400000" })),
    },
    chain: { chainId: 31337 },
    miner: { blockGasLimit: 30_000_000 },
    logging: { quiet: true },
  });
  await server.listen(18546);
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:18546", undefined, {
    staticNetwork: true,
  });
  const deployer = await provider.getSigner(0);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const c = await factory.deploy(await deployer.getAddress());
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`CONTRACT_ADDRESS=${addr}`);
  console.log(`RPC_URL=http://127.0.0.1:18546`);
  console.log(`CHAIN_ID=31337`);
  process.stdout.write("READY\n");
  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
  setInterval(() => {}, 1 << 30);
})().catch((e) => {
  console.error("BOOT FAILED", e);
  process.exit(1);
});