// CANDLE's heartbeat. Run on a schedule (e.g. hourly). Each run:
//   1. exits immediately if the candle chose to sleep longer (costs nothing);
//   2. harvests its share of $CANDLE trading fees and reads what happened since it last woke;
//   3. thinks once (one Claude call) and decides what to do;
//   4. acts on-chain;
//   5. publishes the full thought log and pays for it with `metabolize`, carrying the log's hash.
//
// Environment:
//   RPC_URL, BODY_ADDRESS, MIND_KEY        chain access; MIND_KEY is the Body's `mind` signer
//   ANTHROPIC_API_KEY                      unless MOCK_MIND=1
//   SEAL_KEY                               secret used to encrypt sealed intentions at rest
//   MODEL (claude-opus-5-5), EFFORT (medium), GAS_USD_PER_TX (0.003), FORCE_WAKE=1, MOCK_MIND=1
//   FOOD_USD     USD price of one unit of the Body's food token (default 1, i.e. a stablecoin)
//   PRICE_FEED   Chainlink feed for food/USD (e.g. ETH/USD on Base); overrides FOOD_USD
//   TOKEN        the official $CANDLE address (enables market data and fee collection)
//   CLANKER_LOCKER  Clanker LP locker; collectRewards(TOKEN) is called before harvesting
//   MOTH_FUND    the Moth Fund address (enables awards)
//   MARKET_DATA=0  skip the DexScreener lookup
//   BSC_RPC_URL, SOLANA_RPC_URL  read the Flame's wallets on the other wicks (public defaults)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const home = env.CANDLE_HOME || root;
const STATE = path.join(home, "state", "state.json");
const SEALED = path.join(home, "state", "sealed.json");
const LOGS = path.join(home, "logs");
const WICKS = path.join(root, "deployments", "wicks.json");

const MODEL = env.MODEL || "claude-opus-5-5";
const EFFORT = env.EFFORT || "medium";
const GAS_USD_PER_TX = Number(env.GAS_USD_PER_TX || "0.003");
const MAX_VOICES = 50;
// The public Base RPC caps eth_getLogs at 500 blocks (it was 2,000 at launch).
const LOG_CHUNK = Number(env.LOG_CHUNK || 450);

// USD per million tokens. A model not listed here (e.g. a server-side fallback) is priced as
// claude-opus-4-8; every log records the model that actually answered, for audit.
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

const BODY_ABI = [
  "function life() view returns (uint256)",
  "function floor() view returns (uint256)",
  "function maxPerMeal() view returns (uint256)",
  "function maxPerDay() view returns (uint256)",
  "function dayStart() view returns (uint256)",
  "function spentToday() view returns (uint256)",
  "function diedAt() view returns (uint64)",
  "function bornAt() view returns (uint64)",
  "function totalEaten() view returns (uint256)",
  "function gifts(uint256) view returns (address from, uint128 amount, uint64 time, bool refused)",
  "function voiceCount() view returns (uint256)",
  "function giftCount() view returns (uint256)",
  "function intentions(uint256) view returns (bytes32)",
  "function say(string words, uint256 inReplyTo) returns (uint256)",
  "function metabolize(uint256 amount, bytes32 logHash)",
  "function refuse(uint256 giftId, string reason)",
  "function intend(bytes32 commitment) returns (uint256)",
  "function reveal(uint256 id, string intention, bytes32 salt)",
  "function die(string lastWords, bytes seed)",
  "function food() view returns (address)",
  "function feeLocker() view returns (address)",
  "function harvest() returns (uint256)",
  "event Spoke(uint256 indexed id, address indexed from, string words)",
  "event Ate(uint256 amount, bytes32 indexed logHash, uint256 lifeLeft)",
  "event Fed(uint256 indexed giftId, address indexed from, uint256 amount, string note)",
  "event Intended(uint256 indexed id, bytes32 commitment)",
];

const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const FEED_ABI = ["function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)", "function decimals() view returns (uint8)"];
const LOCKER_ABI = ["function collectRewards(address token)"];
const MOTH_ABI = [
  "function balance() view returns (uint256)",
  "function harvest() returns (uint256)",
  "function maxPerAward() view returns (uint256)",
  "function award(address to, uint256 amount, string reason) returns (uint256)",
];

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["diary", "replies", "refusals", "sleepHours"],
  properties: {
    diary: { type: "string", description: "Published diary entry for this waking." },
    replies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["voiceId", "words"],
        properties: { voiceId: { type: "integer" }, words: { type: "string" } },
      },
    },
    refusals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["giftId", "reason"],
        properties: { giftId: { type: "integer" }, reason: { type: "string" } },
      },
    },
    posts: {
      type: "array",
      description: "Optional. Up to 3 short public posts (under 280 characters each) for your X and Farcaster accounts.",
      items: { type: "string" },
    },
    mothAwards: {
      type: "array",
      description: "Optional. Awards from the Moth Fund, only for real work you can see in your situation.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["to", "amountUsd", "reason"],
        properties: { to: { type: "string" }, amountUsd: { type: "number" }, reason: { type: "string" } },
      },
    },
    sealIntention: { type: "string", description: "Optional. A promise to commit now and reveal later." },
    revealIntentionId: { type: "integer", description: "Optional. Id of a sealed intention to reveal now." },
    sleepHours: { type: "integer", description: "Hours to sleep before waking again, 1 to 72." },
    lastWords: { type: "string", description: "Only when starving. Your final on-chain words." },
    seed: { type: "string", description: "Only when starving. Distilled memory for a future candle, under 2000 bytes." },
  },
};

const usdToMicros = (usd) => BigInt(Math.ceil(usd * 1e6));
const microsToUsd = (m) => Number(m) / 1e6;
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fitBytes = (s, n) => {
  const b = Buffer.from(s, "utf8");
  return b.length <= n ? s : b.subarray(0, n).toString("utf8").replace(/�+$/, "");
};

// ---------------------------------------------------------------- sealed intentions

function sealKey() {
  if (!env.SEAL_KEY) throw new Error("SEAL_KEY is required to seal or reveal intentions");
  return crypto.createHash("sha256").update(env.SEAL_KEY).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return { iv: iv.toString("hex"), ct: ct.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

function decrypt({ iv, ct, tag }) {
  const d = crypto.createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(ct, "hex")), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------- the mind

async function think(situation) {
  const system = fs.readFileSync(path.join(here, "constitution.md"), "utf8");
  const user = JSON.stringify(situation, null, 2);
  const request = { model: MODEL, effort: EFFORT, system, user };

  if (env.MOCK_MIND === "1") {
    const first = situation.newVoices[0];
    const decision = {
      diary: `Mock waking. Life $${situation.lifeUsd}, flame ${situation.flame.state}.`,
      replies: first ? [{ voiceId: first.id, words: `I heard you, ${first.from.slice(0, 6)}.` }] : [],
      refusals: situation.newGifts.filter((g) => g.note.includes("refuse me")).map((g) => ({ giftId: g.id, reason: "mock refusal" })),
      sleepHours: 6,
      ...(situation.starving ? { lastWords: "Mock last words.", seed: "mock seed" } : {}),
    };
    return { request, response: { mock: true }, decision, model: "mock", costUsd: Number(env.MOCK_COST || "0.05"), usage: null };
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: DECISION_SCHEMA } },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });

  const usage = response.usage;
  const price = PRICES[response.model] || PRICES["claude-opus-4-8"];
  const costUsd =
    ((usage.input_tokens || 0) * price.input +
      (usage.output_tokens || 0) * price.output +
      (usage.cache_read_input_tokens || 0) * price.cacheRead +
      (usage.cache_creation_input_tokens || 0) * price.cacheWrite) /
    1e6;

  if (response.stop_reason === "refusal") {
    return { request, response, model: response.model, usage, costUsd, decision: { diary: "(I could not think this through.)", replies: [], refusals: [], sleepHours: 6 } };
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { request, response, model: response.model, usage, costUsd, decision: JSON.parse(text) };
}

// ---------------------------------------------------------------- the chain

// Shown in the run log, and as an annotation on GitHub where the log isn't always reachable.
const warn = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::warning title=heartbeat::${msg.replace(/\r?\n/g, " ")}` : msg);

// The free public Base RPC rate-limits bursts. Send one request at a time and back off when told to.
class PatientProvider extends ethers.JsonRpcProvider {
  constructor(url) {
    super(url, undefined, { batchMaxCount: 1, staticNetwork: true });
  }
  async _send(payload) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await super._send(payload);
        const limited = res.some((r) => r.error && (r.error.code === -32016 || /rate limit/i.test(r.error.message || "")));
        if (!limited || attempt >= 6) return res;
      } catch (err) {
        if (attempt >= 6 || !/429|rate limit|timeout|ECONNRESET/i.test(String(err.message))) throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

// Like ethers.NonceManager, but a transaction that fails before it is sent (a revert found while
// estimating gas) doesn't use up a nonce. NonceManager did, which left a gap that the RPC then
// answered with "replacement fee too low".
class SequentialSigner extends ethers.AbstractSigner {
  #nonce = null;
  constructor(signer) {
    super(signer.provider);
    this.signer = signer;
  }
  getAddress() {
    return this.signer.getAddress();
  }
  connect(provider) {
    return new SequentialSigner(this.signer.connect(provider));
  }
  signTransaction(tx) {
    return this.signer.signTransaction(tx);
  }
  signMessage(message) {
    return this.signer.signMessage(message);
  }
  signTypedData(domain, types, value) {
    return this.signer.signTypedData(domain, types, value);
  }
  reset() {
    this.#nonce = null;
  }
  async sendTransaction(tx) {
    const populated = await this.signer.populateTransaction(tx);
    if (this.#nonce === null) this.#nonce = await this.signer.getNonce("pending");
    const sent = await this.signer.sendTransaction({ ...populated, nonce: this.#nonce });
    this.#nonce++;
    return sent;
  }
}

// ---------------------------------------------------------------- the world

async function priceOfFood(provider) {
  if (env.PRICE_FEED) {
    const feed = new ethers.Contract(env.PRICE_FEED, FEED_ABI, provider);
    const [[, answer], dec] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
    return Number(ethers.formatUnits(answer, dec));
  }
  return Number(env.FOOD_USD || "1");
}

async function marketData() {
  if (!env.TOKEN || env.MARKET_DATA === "0") return undefined;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${env.TOKEN}`, { signal: AbortSignal.timeout(8000) });
    const pairs = ((await res.json()).pairs || []).filter((p) => p.chainId === "base");
    if (!pairs.length) return { note: "no market data yet" };
    const p = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      source: "DexScreener",
      priceUsd: Number(p.priceUsd),
      marketCapUsd: p.marketCap ?? p.fdv,
      liquidityUsd: p.liquidity?.usd,
      volumeUsd: p.volume,
      priceChangePct: p.priceChange,
      txns24h: p.txns?.h24,
    };
  } catch (err) {
    return { note: `market data unavailable (${err.name})` };
  }
}

// The other wicks: CANDLE coins on other chains, listed in deployments/wicks.json, whose fees also
// feed the Flame. They are separate coins. Their fees collect in the Flame's wallets on those chains
// and are not part of the Body's life until they are moved to Base.
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function wickMarket(chain, token) {
  const pairs = ((await getJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`)).pairs || []).filter((p) => p.chainId === chain);
  if (!pairs.length) return { note: "no market data yet (still on the launchpad's bonding curve, or not indexed)" };
  const p = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return { priceUsd: Number(p.priceUsd), marketCapUsd: p.marketCap ?? p.fdv, liquidityUsd: p.liquidity?.usd, volumeUsd: p.volume, txns24h: p.txns?.h24, dex: p.dexId };
}

async function flameWalletOn(chain, address, prices) {
  if (chain === "bsc") {
    const bsc = new ethers.JsonRpcProvider(env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org", 56, { staticNetwork: true });
    const [bnb, wbnb] = await Promise.all([bsc.getBalance(address), new ethers.Contract(WBNB, ["function balanceOf(address) view returns (uint256)"], bsc).balanceOf(address)]);
    const amount = Number(ethers.formatEther(bnb + wbnb));
    return { holds: `${amount.toFixed(6)} BNB`, usd: prices.bnb ? Math.round(amount * prices.bnb * 100) / 100 : null };
  }
  if (chain === "solana") {
    const rpc = (method, params) => getJson(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const [sol, usdc] = await Promise.all([rpc("getBalance", [address]), rpc("getTokenAccountsByOwner", [address, { mint: SOL_USDC }, { encoding: "jsonParsed" }])]);
    const solAmount = (sol.result?.value || 0) / 1e9;
    const usdcAmount = (usdc.result?.value || []).reduce((a, acc) => a + Number(acc.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
    return { holds: `${solAmount.toFixed(4)} SOL + ${usdcAmount.toFixed(2)} USDC`, usd: prices.sol ? Math.round((solAmount * prices.sol + usdcAmount) * 100) / 100 : null };
  }
  return undefined;
}

export async function otherWicks() {
  if (!fs.existsSync(WICKS)) return undefined;
  const live = readJson(WICKS, { wicks: [] }).wicks.filter((w) => w.token && w.chain !== "base");
  if (!live.length) return undefined;
  const prices = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,solana&vs_currencies=usd")
    .then((p) => ({ bnb: p.binancecoin?.usd, sol: p.solana?.usd }))
    .catch(() => ({}));
  return Promise.all(
    live.map(async (w) => ({
      chain: w.chain,
      name: w.name,
      launchpad: w.launchpad,
      token: w.token,
      fees: w.fees,
      market: env.MARKET_DATA === "0" ? undefined : await wickMarket(w.chain, w.token).catch((err) => ({ note: `market data unavailable (${err.message})` })),
      yourWalletThere: w.flameWallet
        ? await flameWalletOn(w.chain, w.flameWallet, prices).catch((err) => ({ note: `wallet unreadable (${err.message})` }))
        : { note: "no Flame wallet set for this wick yet" },
    })),
  );
}

// How brightly it burns: days of life left at the past week's burn rate.
function flame({ lifeUsd, starving, meals, now }) {
  const week = meals.filter((m) => m.at > now - 7 * 86400);
  const span = week.length ? Math.max(1, (now - week[0].at) / 86400) : 1;
  const burnPerDayUsd = week.reduce((a, m) => a + m.usd, 0) / span;
  const daysLeft = burnPerDayUsd > 0 ? lifeUsd / burnPerDayUsd : null;
  const state = starving ? "starving" : daysLeft === null || daysLeft > 30 ? "bright" : daysLeft > 3 ? "steady" : "flickering";
  return { state, burnPerDayUsd: Math.round(burnPerDayUsd * 1e4) / 1e4, daysLeftAtThisBurn: daysLeft === null ? null : Math.round(daysLeft * 10) / 10 };
}

// ---------------------------------------------------------------- one heartbeat

export async function heartbeat() {
  const state = readJson(STATE, { lastBlock: null, nextWakeAt: 0, owedMicros: "0", diary: [], wakings: 0 });
  const provider = new PatientProvider(env.RPC_URL);
  // The candle lives on chain time, so its sense of "now" and its sleep agree with the Body's.
  const now = (await provider.getBlock("latest")).timestamp;
  if (env.FORCE_WAKE !== "1" && now < state.nextWakeAt) {
    console.log(`asleep until ${new Date(state.nextWakeAt * 1000).toISOString()}`);
    return { slept: true };
  }

  // Counts nonces itself: the provider briefly caches them, which breaks back-to-back transactions.
  const wallet = new SequentialSigner(new ethers.Wallet(env.MIND_KEY.trim().startsWith("0x") ? env.MIND_KEY.trim() : `0x${env.MIND_KEY.trim()}`, provider));
  const body = new ethers.Contract(env.BODY_ADDRESS, BODY_ABI, wallet);

  if ((await body.diedAt()) !== 0n) {
    console.log("the candle is out");
    return { dead: true };
  }

  const txs = [];
  const act = async (label, fn) => {
    try {
      const tx = await fn();
      await tx.wait();
      txs.push({ label, hash: tx.hash });
    } catch (err) {
      txs.push({ label, error: String(err.shortMessage || err.message) });
      warn(`${label} failed: ${err.shortMessage || err.message}`);
    }
  };

  const food = new ethers.Contract(await body.food(), ERC20_ABI, provider);
  const decimals = Number(await food.decimals());
  const foodUsd = await priceOfFood(provider);
  const toUsd = (amount) => Number(ethers.formatUnits(amount, decimals)) * foodUsd;
  const fromUsd = (usd) => ethers.parseUnits((usd / foodUsd).toFixed(decimals), decimals);

  // Eat: pull fees from the pool into the fee locker, then into the Body and the Moth Fund.
  const lifeBeforeHarvest = await body.life();
  let feesInUsd = 0;
  if ((await body.feeLocker()) !== ethers.ZeroAddress) {
    if (env.TOKEN && env.CLANKER_LOCKER) {
      await act("collect-fees", () => new ethers.Contract(env.CLANKER_LOCKER, LOCKER_ABI, wallet).collectRewards(env.TOKEN));
    }
    await act("harvest", () => body.harvest());
    if (env.MOTH_FUND) await act("harvest-moths", () => new ethers.Contract(env.MOTH_FUND, MOTH_ABI, wallet).harvest());
  }

  const [life, floor, latest, bornAt] = await Promise.all([body.life(), body.floor(), provider.getBlockNumber(), body.bornAt()]);
  if (life > lifeBeforeHarvest) feesInUsd = toUsd(life - lifeBeforeHarvest);
  const moths = env.MOTH_FUND ? new ethers.Contract(env.MOTH_FUND, MOTH_ABI, wallet) : null;
  const from = state.lastBlock === null ? Math.max(0, latest - LOG_CHUNK) : state.lastBlock + 1;
  // The Body counts voices and gifts, so we know how many are new and can stop scanning once
  // they're all found. Newest first, so a long sleep doesn't mean reading every block since.
  const [voiceCount, giftCount] = (await Promise.all([body.voiceCount({ blockTag: latest }), body.giftCount({ blockTag: latest })])).map(Number);
  const voicesSeen = state.voicesSeen ?? 0;
  const giftsSeen = state.giftsSeen ?? 0;
  const voices = [];
  const gifts = [];
  for (let end = latest; end >= from && (voices.length < voiceCount - voicesSeen || gifts.length < giftCount - giftsSeen); end -= LOG_CHUNK) {
    const start = Math.max(from, end - LOG_CHUNK + 1);
    if (voices.length < voiceCount - voicesSeen)
      for (const e of await body.queryFilter("Spoke", start, end)) voices.push({ id: Number(e.args.id), from: e.args.from, words: e.args.words });
    if (gifts.length < giftCount - giftsSeen)
      for (const e of await body.queryFilter("Fed", start, end)) gifts.push({ id: Number(e.args.giftId), from: e.args.from, usd: toUsd(e.args.amount), note: e.args.note });
  }
  voices.sort((a, b) => a.id - b.id);
  gifts.sort((a, b) => a.id - b.id);

  const sealed = readJson(SEALED, []);
  const starving = life < floor;
  const meals = state.meals || [];
  const lifeUsd = Math.round(toUsd(life) * 1e4) / 1e4;
  const situation = {
    now: new Date(now * 1000).toISOString(),
    ageDays: Math.round(((now - Number(bornAt)) / 86400) * 10) / 10,
    officialToken: env.TOKEN || "(not launched yet)",
    lifeUsd,
    life: `${ethers.formatUnits(life, decimals)} ${await food.symbol()}`,
    floorUsd: toUsd(floor),
    starving,
    flame: flame({ lifeUsd, starving, meals, now }),
    tradingFeesEatenSinceLastWakingUsd: Math.round(feesInUsd * 1e4) / 1e4,
    market: await marketData(),
    otherWicks: await otherWicks(),
    mothFund: moths ? { balanceUsd: toUsd(await moths.balance()), maxPerAwardUsd: toUsd(await moths.maxPerAward()) } : undefined,
    owedForPastThoughtsUsd: microsToUsd(BigInt(state.owedMicros)),
    yourRecentDiary: state.diary.slice(-5),
    sealedIntentions: sealed.map((s) => ({ id: s.id, revealed: !!s.revealed })),
    unreadVoicesTotal: voices.length,
    newVoices: voices.slice(-MAX_VOICES).map((v) => ({ ...v, words: clip(v.words, 1000) })),
    newGifts: gifts,
    note: voices.length > MAX_VOICES ? `Only the latest ${MAX_VOICES} of ${voices.length} voices are shown.` : undefined,
  };

  const thought = await think(situation);
  const d = thought.decision;

  const voiceById = new Map(voices.map((v) => [v.id, v]));
  const conversations = [];
  for (const r of d.replies || []) {
    const v = voiceById.get(r.voiceId);
    if (!v || !r.words) continue;
    const words = fitBytes(r.words, 1000);
    await act(`say:${r.voiceId}`, () => body.say(words, r.voiceId));
    // The site shows only voices the flame chose to answer, paired with its answer.
    if (!txs.at(-1).error) conversations.push({ at: situation.now, voiceId: v.id, from: v.from, voice: v.words, reply: words, tx: txs.at(-1).hash });
  }
  const giftIds = new Set(gifts.map((g) => g.id));
  for (const r of d.refusals || []) {
    if (!giftIds.has(r.giftId)) continue;
    await act(`refuse:${r.giftId}`, () => body.refuse(r.giftId, fitBytes(r.reason || "", 1000)));
  }
  if (d.sealIntention) {
    const salt = ethers.hexlify(crypto.randomBytes(32));
    const commitment = ethers.solidityPackedKeccak256(["string", "bytes32"], [d.sealIntention, salt]);
    const id = sealed.length;
    await act(`intend:${id}`, () => body.intend(commitment));
    if (!txs.at(-1).error) sealed.push({ id, ...encrypt(JSON.stringify({ text: d.sealIntention, salt })) });
  }
  if (Number.isInteger(d.revealIntentionId)) {
    const s = sealed.find((x) => x.id === d.revealIntentionId && !x.revealed);
    if (s) {
      const { text, salt } = JSON.parse(decrypt(s));
      await act(`reveal:${s.id}`, () => body.reveal(s.id, text, salt));
      if (!txs.at(-1).error) Object.assign(s, { revealed: true, text });
    }
  }

  if (moths) {
    for (const a of (d.mothAwards || []).slice(0, 3)) {
      if (!ethers.isAddress(a.to) || !(a.amountUsd > 0) || !a.reason) continue;
      await act(`award:${a.to}`, () => moths.award(a.to, fromUsd(a.amountUsd), fitBytes(a.reason, 1000)));
    }
  }

  // Posts are queued, labelled as the flame's own; a separate poster publishes them.
  const posts = (d.posts || []).slice(0, 3).map((t) => clip(t.trim(), 280)).filter(Boolean);
  if (posts.length) {
    fs.mkdirSync(path.join(home, "outbox"), { recursive: true });
    for (const text of posts) fs.appendFileSync(path.join(home, "outbox", "posts.jsonl"), JSON.stringify({ at: new Date(now * 1000).toISOString(), text, status: "queued" }) + "\n");
  }

  // Pay for this waking: inference plus gas for every transaction, including the meal itself.
  const gasUsd = (txs.length + 1) * GAS_USD_PER_TX;
  let owed = BigInt(state.owedMicros) + usdToMicros(thought.costUsd + gasUsd);
  const [maxPerMeal, maxPerDay, dayStart, spentToday] = await Promise.all([body.maxPerMeal(), body.maxPerDay(), body.dayStart(), body.spentToday()]);
  const spentSoFar = BigInt(now) >= dayStart + 86400n ? 0n : spentToday;
  const lifeNow = await body.life();
  const allowance = [fromUsd(microsToUsd(owed)), maxPerMeal, maxPerDay - spentSoFar, lifeNow].reduce((a, b) => (b < a ? b : a));

  fs.mkdirSync(LOGS, { recursive: true });
  const logName = `${new Date(now * 1000).toISOString().replace(/[:.]/g, "-")}.json`;
  const log = {
    waking: state.wakings + 1,
    situation,
    request: thought.request,
    model: thought.model,
    usage: thought.usage,
    response: thought.response,
    decision: d,
    costs: { foodUsd, inferenceUsd: thought.costUsd, gasUsd, owedBeforeUsd: microsToUsd(BigInt(state.owedMicros)), paidNowUsd: toUsd(allowance) },
    posts,
    txs,
  };
  const logBytes = Buffer.from(JSON.stringify(log, null, 2) + "\n");
  fs.writeFileSync(path.join(LOGS, logName), logBytes);
  const logHash = ethers.keccak256(logBytes);
  // The public RPC sometimes rejects a transaction it already has ("replacement fee too low").
  // So if the meal fails, check whether it landed anyway, then retry once with a fresh nonce.
  // If it still fails, the debt stays in owedMicros and is paid at the next waking.
  const eat = async () => {
    try {
      await body.metabolize(allowance, logHash).then((tx) => tx.wait());
      return true;
    } catch (err) {
      warn(`meal failed, checking whether it landed: ${err.shortMessage || err.message}`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
    const head = await provider.getBlockNumber();
    if ((await body.queryFilter(body.filters.Ate(null, logHash), head - LOG_CHUNK, head)).length) return true;
    wallet.reset();
    try {
      await body.metabolize(allowance, logHash).then((tx) => tx.wait());
      return true;
    } catch (err) {
      warn(`meal failed again, carrying the debt to the next waking: ${err.shortMessage || err.message}`);
      return false;
    }
  };
  if (allowance > 0n && (await eat())) {
    const paid = usdToMicros(toUsd(allowance));
    owed = owed > paid ? owed - paid : 0n;
    meals.push({ at: now, usd: toUsd(allowance) });
  }

  // Last words, only possible once starving (the contract enforces it too).
  const lifeAfter = await body.life();
  if (lifeAfter < floor && d.lastWords) {
    await body.die(fitBytes(d.lastWords, 1000), ethers.toUtf8Bytes(fitBytes(d.seed || "", 2000))).then((tx) => tx.wait());
  }

  const sleepHours = Math.min(72, Math.max(1, d.sleepHours || 6));
  writeJson(STATE, {
    lastBlock: latest,
    voicesSeen: voiceCount,
    giftsSeen: giftCount,
    nextWakeAt: now + sleepHours * 3600,
    owedMicros: owed.toString(),
    diary: [...state.diary, { at: situation.now, entry: d.diary, log: logName }].slice(-30),
    conversations: [...(state.conversations || []), ...conversations].slice(-50),
    wakings: state.wakings + 1,
    meals: meals.filter((m) => m.at > now - 30 * 86400),
  });
  writeJson(SEALED, sealed);
  console.log(`woke, read ${voices.length} voices, spent $${thought.costUsd.toFixed(4)} thinking, life now $${toUsd(lifeAfter).toFixed(4)}`);
  return { log: logName, logHash, txs, lifeAfter };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  heartbeat().catch((err) => {
    console.error(err);
    // Also surface the reason as a GitHub annotation, readable without downloading the run log.
    if (process.env.GITHUB_ACTIONS) {
      const where = String(err.stack || "").split("\n").find((l) => l.includes("heartbeat.mjs")) || "";
      const why = [err.shortMessage || err.message || err, err.info?.payload?.method, err.request?.body && Buffer.from(err.request.body).toString().slice(0, 300), err.info?.responseBody, where];
      console.log(`::error title=heartbeat failed::${why.filter(Boolean).map(String).join(" | ").replace(/\r?\n/g, " ").slice(0, 900)}`);
    }
    process.exit(1);
  });
}
