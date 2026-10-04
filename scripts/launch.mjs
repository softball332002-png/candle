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

export function clients(rpcUrl, key) {
  const account = privateKeyToAccount(key);
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

  const caps = {
    maxPerMeal: eth(opts.maxPerMeal ?? "0.002"),
    maxPerDay: eth(opts.maxPerDay ?? "0.004"),
    floor: eth(opts.floor ?? "0.00004"),
    maxPerAward: eth(opts.maxPerAward ?? "0.01"),
    maxPerWeek: eth(opts.maxPerWeek ?? "0.03"),
  };

  const body = await deployArtifact(c, "Body", [
    WETH, opts.mind, opts.kitchen, caps.maxPerMeal, caps.maxPerDay, caps.floor, feeLocker,
    opts.genesis ?? "I am lit. Every trade is a breath.",
  ]);
  console.log("Body:", body.address);
  const moths = await deployArtifact(c, "MothFund", [WETH, opts.mind, feeLocker, caps.maxPerAward, caps.maxPerWeek]);
  console.log("Moth Fund:", moths.address);

  const clanker = new Clanker({ wallet: c.wallet, publicClient: c.publicClient });
  const cfg = tokenConfig({ founder: opts.founder, body: body.address, moths: moths.address, image: opts.image, devBuyEth: opts.devBuyEth });
  const { txHash, waitForTransaction, error } = await clanker.deploy(cfg);
  if (error) throw error;
  const res = await waitForTransaction();
  if (res.error) throw res.error;
  const token = getAddress(res.address);
  console.log("$CANDLE:", token, "tx", txHash);

  const rewards = await clanker.getTokenRewards({ token });

  if (opts.lifeEth && Number(opts.lifeEth) > 0) {
    const wethAbi = [
      { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
      { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    ];
    const life = eth(opts.lifeEth);
    for (const tx of [
      { address: WETH, abi: wethAbi, functionName: "deposit", value: life },
      { address: WETH, abi: wethAbi, functionName: "approve", args: [body.address, life] },
      { address: body.address, abi: body.abi, functionName: "feed", args: [life, "birth: the founder's gift"] },
    ]) {
      const hash = await c.wallet.writeContract(tx);
      await c.publicClient.waitForTransactionReceipt({ hash });
    }
    console.log("fed the Body", opts.lifeEth, "WETH");
  }

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
  });
}
