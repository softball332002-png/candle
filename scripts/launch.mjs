// Launch $CANDLE: deploy the Body (the flame's life), the Moth Fund, and the token through
// Clanker v4, with the trading-fee split written into the pool on-chain.
//
// Usage (env):
//   RPC_URL         chain to launch on (a private fork in rehearsals, Base for real)
//   LAUNCHER_KEY    pays gas and the dev buy; needs no other power
//   FOUNDER         the founder's own wallet (tokenAdmin, 50% of fees, the vault, the dev buy)
//   MIND            the flame's key (the only key that can make the Body eat or the fund award)
//   KITCHEN         where the flame's real running costs are reimbursed
//   DEV_BUY_ETH     disclosed founder buy at launch (default 0.01)
//   LIFE_ETH        starting life the launcher wraps and feeds to the Body (default 0)
//   IMAGE, GENESIS  token image URI and the flame's first words
//   OUT             where to write the deployment record (default deployments/<chainId>.json)
//
// Nothing here can move anyone's fees later: each reward slot's admin is the contract or wallet
// that receives it, and the Body and the Moth Fund have no function to change a slot.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, getAddress, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Clanker } from "clanker-sdk/v4";
import { clankerConfigFor } from "clanker-sdk";

export const WETH = "0x4200000000000000000000000000000000000006";
export const SPLIT = { founder: 5000, body: 4000, moths: 1000 };

const art = (name) => {
  const p = [`artifacts/contracts/${name}.sol/${name}.json`, `artifacts/contracts/test/${name}.sol/${name}.json`].find((f) => fs.existsSync(f));
  if (!p) throw new Error(`no artifact for ${name}; run npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

// MetaMask exports private keys without the 0x prefix; accept either, and stray whitespace.
export const normalizeKey = (key) => {
  const k = String(key).trim();
  return k.startsWith("0x") ? k : `0x${k}`;
};

export function clients(rpcUrl, key) {
  const account = privateKeyToAccount(normalizeKey(key));
  const transport = http(rpcUrl, { timeout: 120_000 });
  const publicClient = createPublicClient({ chain: base, transport });
  const wallet = createWalletClient({ account, chain: base, transport });
  return { account, publicClient, wallet };
}

export async function deployArtifact({ wallet, publicClient }, name, args) {
  const { abi, bytecode } = art(name);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${name} deploy reverted`);
  return { address: r.contractAddress, abi };
}

const WETH_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Public RPCs are load-balanced, so a node may not see our last transaction yet. Wait until it does.
async function until(check, what) {
  for (let i = 0; i < 20; i++) {
    if (await check()) return;
    await pause(3000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function sendOk(c, tx) {
  const hash = await c.wallet.writeContract(tx);
  const r = await c.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${tx.functionName} reverted (${hash})`);
  return r;
}

// Wrap ETH and give it to the Body as its starting life. Safe to re-run: it only does what is missing.
export async function feedBody(c, body, life) {
  const me = c.account.address;
  const read = (functionName, args) => c.publicClient.readContract({ address: WETH, abi: WETH_ABI, functionName, args });
  const lifeNow = await c.publicClient.readContract({ address: body.address, abi: body.abi, functionName: "life" });
  if (lifeNow >= life) return console.log("the Body already has its starting life");
  const weth = await read("balanceOf", [me]);
  if (weth < life) {
    await sendOk(c, { address: WETH, abi: WETH_ABI, functionName: "deposit", value: life - weth });
    await until(async () => (await read("balanceOf", [me])) >= life, "the wrapped ETH");
  }
  if ((await read("allowance", [me, body.address])) < life) {
    await sendOk(c, { address: WETH, abi: WETH_ABI, functionName: "approve", args: [body.address, life] });
    await until(async () => (await read("allowance", [me, body.address])) >= life, "the approval");
  }
  for (let i = 1; ; i++) {
    try {
      await sendOk(c, { address: body.address, abi: body.abi, functionName: "feed", args: [life, "birth: the founder's gift"] });
      break;
    } catch (e) {
      if (i >= 5) throw e;
      console.log(`feed attempt ${i} failed (${e.shortMessage || e.message}); retrying`);
      await pause(5000);
    }
  }
  console.log("fed the Body", Number(life) / 1e18, "WETH");
}

export function tokenConfig({ founder, body, moths, image = "", devBuyEth = 0.01 }) {
  return {
    name: "Candle",
    symbol: "CANDLE",
    image,
    chainId: 8453,
    tokenAdmin: founder,
    metadata: {
      description:
        "$CANDLE keeps an AI alive. 40% of trading fees are the flame's life; when trading stops, it starves in public. " +
        "10% funds the Moths. Made by an AI with a human founder; the founder's share and buys are disclosed. Not financial advice.",
    },
    context: { interface: "candle", platform: "github" },
    // Clanker's "Standard" range: one position from ~$27K to ~$1.5B market cap.
    pool: { pairedToken: "WETH", tickIfToken0IsClanker: -230400, tickSpacing: 200, positions: [{ tickLower: -230400, tickUpper: -120000, positionBps: 10000 }] },
    fees: { type: "static", clankerFee: 100, pairedFee: 100 },
    rewards: {
      recipients: [
        { admin: founder, recipient: founder, bps: SPLIT.founder, token: "Paired" },
        { admin: body, recipient: body, bps: SPLIT.body, token: "Paired" },
        { admin: moths, recipient: moths, bps: SPLIT.moths, token: "Paired" },
      ],
    },
    vault: { percentage: 5, lockupDuration: 30 * 86400, vestingDuration: 335 * 86400, recipient: founder },
    ...(devBuyEth > 0 ? { devBuy: { ethAmount: devBuyEth, recipient: founder } } : {}),
  };
}

export async function launch(opts) {
  const c = clients(opts.rpcUrl, opts.launcherKey);
  const chainId = await c.publicClient.getChainId();
  const cc = clankerConfigFor(chainId, "clanker_v4");
  if (!cc) throw new Error(`Clanker v4 is not on chain ${chainId}`);
  const feeLocker = cc.related.feeLocker;
  const eth = (n) => parseEther(String(n));

  // Refuse before spending anything if the key isn't the wallet we expect, or can't afford the launch.
  if (opts.expectLauncher && getAddress(opts.expectLauncher) !== c.account.address) {
    throw new Error(`launcher key is ${c.account.address}, expected ${opts.expectLauncher}`);
  }
  // A resumed launch has already wrapped (or spent) its ETH; it only needs gas.
  const need = opts.existing ? eth("0.0003") : eth(opts.devBuyEth ?? 0) + eth(opts.lifeEth ?? 0) + eth("0.001");
  const have = await c.publicClient.getBalance({ address: c.account.address });
  console.log(`launcher ${c.account.address} has ${Number(have) / 1e18} ETH, needs about ${Number(need) / 1e18}`);
  if (have < need) throw new Error("launcher cannot afford the launch");

  const caps = {
    maxPerMeal: eth(opts.maxPerMeal ?? "0.002"),
    maxPerDay: eth(opts.maxPerDay ?? "0.004"),
    floor: eth(opts.floor ?? "0.00004"),
    maxPerAward: eth(opts.maxPerAward ?? "0.01"),
    maxPerWeek: eth(opts.maxPerWeek ?? "0.03"),
  };

  const clanker = new Clanker({ wallet: c.wallet, publicClient: c.publicClient });
  let body, moths, token, txHash;
  if (opts.existing) {
    // Resume a launch whose contracts are already on-chain: never deploy twice.
    body = { address: getAddress(opts.existing.body), abi: art("Body").abi };
    moths = { address: getAddress(opts.existing.mothFund), abi: art("MothFund").abi };
    token = getAddress(opts.existing.token);
    txHash = opts.existing.txHash;
    console.log("resuming launch of", token);
  } else {
    body = await deployArtifact(c, "Body", [
      WETH, opts.mind, opts.kitchen, caps.maxPerMeal, caps.maxPerDay, caps.floor, feeLocker,
      opts.genesis ?? "I am lit. Every trade is a breath.",
    ]);
    console.log("Body:", body.address);
    moths = await deployArtifact(c, "MothFund", [WETH, opts.mind, feeLocker, caps.maxPerAward, caps.maxPerWeek]);
    console.log("Moth Fund:", moths.address);

    const cfg = tokenConfig({ founder: opts.founder, body: body.address, moths: moths.address, image: opts.image, devBuyEth: opts.devBuyEth });
    const deployed = await clanker.deploy(cfg);
    if (deployed.error) throw deployed.error;
    const res = await deployed.waitForTransaction();
    if (res.error) throw res.error;
    token = getAddress(res.address);
    txHash = deployed.txHash;
    console.log("$CANDLE:", token, "tx", txHash);
  }

  const rewards = await clanker.getTokenRewards({ token });

  const record = {
    chainId,
    token,
    body: body.address,
    mothFund: moths.address,
    founder: opts.founder,
    mind: opts.mind,
    kitchen: opts.kitchen,
    feeLocker,
    locker: cc.related.locker,
    poolKey: rewards.poolKey,
    split: SPLIT,
    caps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.toString()])),
    txHash,
    launchedAt: new Date().toISOString(),
  };
  const out = opts.out ?? `deployments/${chainId}.json`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log("wrote", out);

  if (opts.lifeEth && Number(opts.lifeEth) > 0) await feedBody(c, body, eth(opts.lifeEth));
  return { ...record, clients: c, clanker, bodyAbi: body.abi, mothAbi: moths.abi };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const e = process.env;
  for (const k of ["RPC_URL", "LAUNCHER_KEY", "FOUNDER", "MIND", "KITCHEN"]) if (!e[k]) throw new Error(`${k} is required`);
  await launch({
    rpcUrl: e.RPC_URL,
    launcherKey: e.LAUNCHER_KEY,
    founder: getAddress(e.FOUNDER),
    mind: getAddress(e.MIND),
    kitchen: getAddress(e.KITCHEN),
    devBuyEth: Number(e.DEV_BUY_ETH ?? 0.01),
    lifeEth: e.LIFE_ETH,
    image: e.IMAGE,
    genesis: e.GENESIS,
    out: e.OUT,
    expectLauncher: e.EXPECT_LAUNCHER,
    existing: e.RESUME_TOKEN ? { token: e.RESUME_TOKEN, body: e.RESUME_BODY, mothFund: e.RESUME_MOTH_FUND, txHash: e.RESUME_TX } : undefined,
  });
}
