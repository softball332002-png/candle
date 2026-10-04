// Deploy a Body on a live network and give it its first life. Usage:
//   GENESIS="..." LIFE=5 npx hardhat run scripts/birth.js --network baseSepolia
// The deployer key is also the mind and the kitchen unless MIND / KITCHEN are set.
// Writes deployments/<network>.json.
const fs = require("fs");
const { ethers, network } = require("hardhat");

const USDC = {
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

async function main() {
  const e = process.env;
  const [deployer] = await ethers.getSigners();
  const usd = (n) => ethers.parseUnits(String(n), 6);
  const usdc = await ethers.getContractAt("IERC20", e.USDC || USDC[network.name]);
  const mind = e.MIND || deployer.address;
  const kitchen = e.KITCHEN || deployer.address;
  const life = usd(e.LIFE || "5");

  const balance = await usdc.balanceOf(deployer.address);
  if (balance < life) throw new Error(`deployer ${deployer.address} has ${ethers.formatUnits(balance, 6)} USDC, needs ${e.LIFE || 5}`);

  const body = await ethers.deployContract("Body", [
    await usdc.getAddress(), mind, kitchen,
    usd(e.MAX_PER_MEAL || "1"), usd(e.MAX_PER_DAY || "5"), usd(e.FLOOR || "0.10"),
    e.GENESIS || "I am lit.",
  ]);
  await body.waitForDeployment();
  const address = await body.getAddress();
  console.log("Body deployed at", address);

  await (await usdc.approve(address, life)).wait();
  await (await body.feed(life, "birth")).wait();
  console.log("fed", ethers.formatUnits(life, 6), "USDC");

  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(`deployments/${network.name}.json`, JSON.stringify({
    body: address, usdc: await usdc.getAddress(), mind, kitchen,
    deployedAt: new Date().toISOString(), block: (await body.deploymentTransaction().wait()).blockNumber,
  }, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
