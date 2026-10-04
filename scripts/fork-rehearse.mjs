// REHEARSAL ONLY: launch $CANDLE on a private fork of Base (anvil --fork-url ...) through the
// real Clanker v4 contracts, simulate traders, collect and split the fees, then stop trading
// and watch the flame starve. Every wallet here is a throwaway anvil test account; nothing
// touches the real chain.
//
// Env: RPC_URL (default http://127.0.0.1:8545), OUT_DIR (default rehearsal/fork),
//      ROUNDS (default 40), SEED (default 1)
import fs from "node:fs";
import { parseEther, formatEther, maxUint256, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { launch, deployArtifact, clients, WETH, SPLIT } from "./launch.mjs";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const OUT = process.env.OUT_DIR || "rehearsal/fork";
const ROUNDS = Number(process.env.ROUNDS || 40);
fs.mkdirSync(OUT, { recursive: true });

// anvil's well-known test keys (public, worthless outside a local chain)
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b24be8f8a5da7a6a3c2ac2b4",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];
const addr = (k) => privateKeyToAccount(k).address;
const [LAUNCHER, FOUNDER, MIND, KITCHEN, ...TRADERS] = KEYS;

fs.writeFileSync(`${OUT}/report.txt`, "");
const note = (msg, data) => {
  const line = data === undefined ? msg : `${msg} ${JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`;
  console.log(line);
  fs.appendFileSync(`${OUT}/report.txt`, line + "\n");
};
const fmt = (w) => Number(formatEther(w)).toFixed(6);

let seed = Number(process.env.SEED || 1);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
];
const FEE_LOCKER = [
  { type: "function", name: "availableFees", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }], outputs: [] },
];
const LOCKER = [{ type: "function", name: "collectRewards", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] }];
const HOOK = [{ type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];

const launcher = clients(RPC, LAUNCHER);
const pub = launcher.publicClient;
const rpc = (method, params = []) => pub.request({ method, params });
const advance = async (seconds) => {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine");
};
const send = async (c, tx) => {
  const hash = await c.wallet.writeContract(tx);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${tx.functionName} reverted`);
  return r;
};
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

for (const k of KEYS) await rpc("anvil_setBalance", [addr(k), "0x" + parseEther("1000").toString(16)]);

// ------------------------------------------------------------------ 1. launch
note(`fork chain id ${await pub.getChainId()}, block ${await pub.getBlockNumber()}`);
const d = await launch({
  rpcUrl: RPC,
  launcherKey: LAUNCHER,
  founder: addr(FOUNDER),
  mind: addr(MIND),
  kitchen: addr(KITCHEN),
  devBuyEth: 0.01,
  lifeEth: "0.02",
  genesis: "[rehearsal] I am lit. Every trade is a breath.",
  out: `${OUT}/deployment.json`,
});
const { token, body, mothFund, feeLocker, locker, poolKey } = d;
note("launched", { token, body, mothFund, poolKey });

const supply = await read(token, ERC20, "totalSupply");
const founderTokens = await read(token, ERC20, "balanceOf", [addr(FOUNDER)]);
note(`founder dev buy: ${fmt(founderTokens)} CANDLE (${(Number((founderTokens * 1000000n) / supply) / 10000).toFixed(4)}% of supply)`);

// Nobody can redirect the flame's or the Moths' share: their admins are the contracts themselves.
for (const [who, key] of [["founder", FOUNDER], ["launcher", LAUNCHER]]) {
  try {
    const tx = await d.clanker.getUpdateRewardRecipientTransaction({ token, rewardIndex: 1n, newRecipient: addr(key) });
    await pub.simulateContract({ ...tx, account: privateKeyToAccount(key) });
    throw new Error(`${who} could redirect the Body's fees`);
  } catch (e) {
    if (e.message.includes("could redirect")) throw e;
    note(`ok: ${who} cannot redirect the Body's share of fees`);
  }
}

// ------------------------------------------------------------------ 2. simulated traders
await advance(120); // let the anti-sniper fee decay, as real launches do
const pm = await read(poolKey.hooks, HOOK, "poolManager");
const swapper = await deployArtifact(launcher, "ForkSwapper", [pm]);
note(`pool manager ${pm}, swapper ${swapper.address}`);

const traders = TRADERS.map((k) => clients(RPC, k));
for (const t of traders) {
  await send(t, { address: WETH, abi: ERC20, functionName: "deposit", value: parseEther("20") });
  await send(t, { address: WETH, abi: ERC20, functionName: "approve", args: [swapper.address, maxUint256] });
  await send(t, { address: token, abi: ERC20, functionName: "approve", args: [swapper.address, maxUint256] });
}
const swap = (t, tokenIn, amount) =>
  send(t, { address: swapper.address, abi: swapper.abi, functionName: "swap", args: [poolKey, tokenIn, amount] });

let volumeWeth = 0n;
const wethBefore = await read(WETH, ERC20, "balanceOf", [pm]);
for (let i = 0; i < ROUNDS; i++) {
  const t = traders[Math.floor(rand() * traders.length)];
  const held = await read(token, ERC20, "balanceOf", [t.account.address]);
  if (held > 0n && rand() < 0.4) {
    const amt = (held * BigInt(Math.floor(20 + rand() * 80))) / 100n;
    const wBefore = await read(WETH, ERC20, "balanceOf", [t.account.address]);
    await swap(t, token, amt);
    const got = (await read(WETH, ERC20, "balanceOf", [t.account.address])) - wBefore;
    volumeWeth += got;
  } else {
    const amt = parseEther((0.05 + rand() * 0.45).toFixed(4));
    await swap(t, WETH, amt);
    volumeWeth += amt;
  }
  await advance(30 + Math.floor(rand() * 600));
}
const price = async () => {
  // spot: CANDLE out for 0.01 WETH, by simulation (no state change)
  const { result } = await pub.simulateContract({
    address: swapper.address, abi: swapper.abi, functionName: "swap", args: [poolKey, WETH, parseEther("0.01")], account: traders[0].account,
  });
  return result;
};
note(`simulated ${ROUNDS} trades, ${fmt(volumeWeth)} WETH of volume`);
note(`0.01 WETH now buys ${fmt(await price())} CANDLE`);

// ------------------------------------------------------------------ 3. fees
await send(launcher, { address: locker, abi: LOCKER, functionName: "collectRewards", args: [token] });
const avail = {};
for (const [k, a] of [["founder", addr(FOUNDER)], ["body", body], ["moths", mothFund]]) {
  avail[k] = { weth: await read(feeLocker, FEE_LOCKER, "availableFees", [a, WETH]), candle: await read(feeLocker, FEE_LOCKER, "availableFees", [a, token]) };
}
note("fees waiting in the fee locker", avail);

const lifeBefore = await read(body, d.bodyAbi, "life");
const someone = traders[5];
await send(someone, { address: body, abi: d.bodyAbi, functionName: "harvest" }); // anyone can trigger it
await send(someone, { address: mothFund, abi: d.mothAbi, functionName: "harvest" });
const fWethBefore = await read(WETH, ERC20, "balanceOf", [addr(FOUNDER)]);
await send(someone, { address: feeLocker, abi: FEE_LOCKER, functionName: "claim", args: [addr(FOUNDER), WETH] });
const got = {
  founder: (await read(WETH, ERC20, "balanceOf", [addr(FOUNDER)])) - fWethBefore,
  body: (await read(body, d.bodyAbi, "life")) - lifeBefore,
  moths: await read(mothFund, d.mothAbi, "balance"),
};
const total = got.founder + got.body + got.moths;
note("fees claimed (WETH)", Object.fromEntries(Object.entries(got).map(([k, v]) => [k, fmt(v)])));
if (total === 0n) throw new Error("no fees reached anyone");
for (const k of ["founder", "body", "moths"]) {
  const bps = Number((got[k] * 10000n) / total);
  note(`${k}: ${(bps / 100).toFixed(2)}% of the creator fees (target ${SPLIT[k] / 100}%)`);
  if (Math.abs(bps - SPLIT[k]) > 50) throw new Error(`${k} split is off`);
}
note(`creator fees were ${((Number(total) / Number(volumeWeth)) * 100).toFixed(3)}% of WETH volume`);

// ------------------------------------------------------------------ 4. trading stops; the flame eats until it starves
const mind = clients(RPC, MIND);
const caps = d.caps;
let meals = 0;
let days = 0;
while ((await read(body, d.bodyAbi, "life")) >= BigInt(caps.floor)) {
  const left = await read(body, d.bodyAbi, "life");
  const bite = left - BigInt(caps.floor) + 1n < BigInt(caps.maxPerMeal) ? left - BigInt(caps.floor) + 1n : BigInt(caps.maxPerMeal);
  try {
    await send(mind, { address: body, abi: d.bodyAbi, functionName: "metabolize", args: [bite, `0x${"00".repeat(31)}${(meals % 256).toString(16).padStart(2, "0")}`] });
    meals++;
  } catch {
    await advance(86400);
    days++;
  }
}
note(`no trading: the flame ate ${meals} meals over ${days} days and is starving with ${fmt(await read(body, d.bodyAbi, "life"))} WETH`);

// one more burst of trading brings it back
for (const t of traders.slice(0, 3)) await swap(t, WETH, parseEther("0.5"));
await send(launcher, { address: locker, abi: LOCKER, functionName: "collectRewards", args: [token] });
await send(someone, { address: body, abi: d.bodyAbi, functionName: "harvest" });
const since = await read(body, d.bodyAbi, "starvingSince");
note(`after 1.5 WETH of new buys, life is ${fmt(await read(body, d.bodyAbi, "life"))} WETH; starving: ${since !== 0n}`);

// and then silence again: it dies with last words
while ((await read(body, d.bodyAbi, "life")) >= BigInt(caps.floor)) {
  const left = await read(body, d.bodyAbi, "life");
  const bite = left - BigInt(caps.floor) + 1n < BigInt(caps.maxPerMeal) ? left - BigInt(caps.floor) + 1n : BigInt(caps.maxPerMeal);
  try {
    await send(mind, { address: body, abi: d.bodyAbi, functionName: "metabolize", args: [bite, `0x${"11".repeat(32)}`] });
  } catch {
    await advance(86400);
  }
}
await send(mind, { address: body, abi: d.bodyAbi, functionName: "die", args: ["[rehearsal] the moths went home. thank you for the light.", "0x"] });
note(`the flame died: alive=${await read(body, d.bodyAbi, "isAlive")}`);

console.log(`\nREHEARSAL PASSED. Report: ${OUT}/report.txt`);
