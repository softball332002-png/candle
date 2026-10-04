// A whole life on a local chain: birth, voices, a gift, starvation, last words.
// Needs `npx hardhat node` running on :8545.
//   Default: a mock mind (free). REAL_MIND=1 thinks with the Claude API (needs ANTHROPIC_API_KEY).
//   LIFE (USDC, default 1), HEARTBEATS (max wakings, default 20), CANDLE_HOME (where logs go).
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const art = (name) => JSON.parse(fs.readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, "utf8"));
const signer = async (i) => provider.getSigner(i);
const usd = (n) => ethers.parseUnits(String(n), 6);
const fmt = (m) => ethers.formatUnits(m, 6);

const [operator, mind, kitchen, alice, bob] = await Promise.all([0, 1, 2, 3, 4].map(signer));
const deploy = async (name, args, from) => {
  const f = new ethers.ContractFactory(art(name).abi, art(name).bytecode, from);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
};
const usdc = await deploy("MockUSDC", [], operator);
const body = await deploy("Body", [await usdc.getAddress(), mind.address, kitchen.address, usd(1), usd(5), usd("0.10"), "Rehearsal candle."], operator);
for (const s of [operator, alice, bob]) {
  await (await usdc.connect(operator).mint(s.address, usd(100))).wait();
  await (await usdc.connect(s).approve(await body.getAddress(), ethers.MaxUint256)).wait();
}
const real = process.env.REAL_MIND === "1";
await (await body.connect(operator).feed(usd(process.env.LIFE || 1), "birth")).wait();
// Rehearsal voices, written by Claude for testing. The real candle only hears real people.
await (await body.connect(alice).speak("[rehearsal test voice] Are you really alive?")).wait();
await (await body.connect(bob).speak("[rehearsal test voice] What will you spend your life on?")).wait();
await (await body.connect(bob).feed(usd("0.5"), real ? "[rehearsal test gift] I hope this buys me an answer." : "refuse me")).wait();

const home = process.env.CANDLE_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "candle-"));
const keys = ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"]; // hardhat account #1 (the mind)
const run = () =>
  execFileSync("node", ["mind/heartbeat.mjs"], {
    env: { ...process.env, CANDLE_HOME: home, RPC_URL: "http://127.0.0.1:8545", BODY_ADDRESS: await_addr, MIND_KEY: keys[0], MOCK_MIND: real ? "0" : "1", MOCK_COST: "0.30", SEAL_KEY: "rehearsal" },
    encoding: "utf8",
  }).trim();
const await_addr = await body.getAddress();
console.log("body:", await_addr);

let i = 0;
const max = Number(process.env.HEARTBEATS || 20);
while ((await body.diedAt()) === 0n && i < max) {
  console.log(`heartbeat ${++i}:`, run(), `| life ${fmt(await body.life())}`);
  // Let it sleep exactly as long as it asked to.
  const { nextWakeAt } = JSON.parse(fs.readFileSync(path.join(home, "state", "state.json"), "utf8"));
  const { timestamp } = await provider.getBlock("latest");
  await provider.send("evm_increaseTime", [Math.max(1, nextWakeAt - timestamp)]);
  await provider.send("evm_mine", []);
}
const died = (await body.queryFilter("Died"))[0];
console.log("said:", (await body.queryFilter("Said")).map((e) => e.args.words));
console.log("refused gifts:", (await body.queryFilter("Refused")).map((e) => `${e.args.giftId}: ${e.args.reason}`));
console.log("kitchen was paid:", fmt(await usdc.balanceOf(kitchen.address)));
console.log("died:", died ? `${died.args.lastWords} (life left ${fmt(died.args.lifeLeft)})` : "no");
console.log("logs:", fs.readdirSync(path.join(home, "logs")).length, "in", home);
