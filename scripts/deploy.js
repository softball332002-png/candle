// Deploy a Body. Usage:
//   USDC=0x... MIND=0x... KITCHEN=0x... GENESIS="..." npx hardhat run scripts/deploy.js --network baseSepolia
// Caps default to 1 USDC per meal, 5 USDC per day, floor 0.10 USDC.
const { ethers } = require("hardhat");

async function main() {
  const e = process.env;
  for (const k of ["USDC", "MIND", "KITCHEN", "GENESIS"]) if (!e[k]) throw new Error(`${k} is required`);
  const usd = (n) => ethers.parseUnits(n, 6);
  const body = await ethers.deployContract("Body", [
    e.USDC, e.MIND, e.KITCHEN,
    usd(e.MAX_PER_MEAL || "1"), usd(e.MAX_PER_DAY || "5"), usd(e.FLOOR || "0.10"),
    e.GENESIS,
  ]);
  await body.waitForDeployment();
  console.log("Body deployed at", await body.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
