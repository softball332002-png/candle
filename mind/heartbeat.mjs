// CANDLE's heartbeat. Run on a schedule (e.g. hourly). Each run:
//   1. exits immediately if the candle chose to sleep longer (costs nothing);
//   2. reads what happened on-chain since it last woke;
//   3. thinks once (one Claude call) and decides what to do;
//   4. acts on-chain;
//   5. publishes the full thought log and pays for it with `metabolize`, carrying the log's hash.
//
// Environment:
//   RPC_URL, BODY_ADDRESS, MIND_KEY        chain access; MIND_KEY is the Body's `mind` signer
//   ANTHROPIC_API_KEY                      unless MOCK_MIND=1
//   SEAL_KEY                               secret used to encrypt sealed intentions at rest
//   MODEL (claude-opus-5-5), EFFORT (medium), GAS_USD_PER_TX (0.003), FORCE_WAKE=1, MOCK_MIND=1

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

const MODEL = env.MODEL || "claude-opus-5-5";
const EFFORT = env.EFFORT || "medium";
const GAS_USD_PER_TX = Number(env.GAS_USD_PER_TX || "0.003");
const MAX_VOICES = 50;
const LOG_CHUNK = 9_000;

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
  "function intentions(uint256) view returns (bytes32)",
  "function say(string words, uint256 inReplyTo) returns (uint256)",
  "function metabolize(uint256 amount, bytes32 logHash)",
  "function refuse(uint256 giftId, string reason)",
  "function intend(bytes32 commitment) returns (uint256)",
  "function reveal(uint256 id, string intention, bytes32 salt)",
  "function die(string lastWords, bytes seed)",
  "event Spoke(uint256 indexed id, address indexed from, string words)",
  "event Fed(uint256 indexed giftId, address indexed from, uint256 amount, string note)",
  "event Intended(uint256 indexed id, bytes32 commitment)",
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
      diary: `Mock waking. Life ${situation.lifeUsd} USDC.`,
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

// ---------------------------------------------------------------- one heartbeat

export async function heartbeat() {
  const state = readJson(STATE, { lastBlock: null, nextWakeAt: 0, owedMicros: "0", diary: [], wakings: 0 });
  const provider = new ethers.JsonRpcProvider(env.RPC_URL);
  // The candle lives on chain time, so its sense of "now" and its sleep agree with the Body's.
  const now = (await provider.getBlock("latest")).timestamp;
  if (env.FORCE_WAKE !== "1" && now < state.nextWakeAt) {
    console.log(`asleep until ${new Date(state.nextWakeAt * 1000).toISOString()}`);
    return { slept: true };
  }

  // NonceManager: the provider briefly caches nonces, which breaks back-to-back transactions.
  const wallet = new ethers.NonceManager(new ethers.Wallet(env.MIND_KEY, provider));
  const body = new ethers.Contract(env.BODY_ADDRESS, BODY_ABI, wallet);

  if ((await body.diedAt()) !== 0n) {
    console.log("the candle is out");
    return { dead: true };
  }

  const [life, floor, latest, bornAt] = await Promise.all([body.life(), body.floor(), provider.getBlockNumber(), body.bornAt()]);
  const from = state.lastBlock === null ? Math.max(0, latest - LOG_CHUNK) : state.lastBlock + 1;
  const voices = [];
  const gifts = [];
  for (let start = from; start <= latest; start += LOG_CHUNK) {
    const end = Math.min(latest, start + LOG_CHUNK - 1);
    for (const e of await body.queryFilter("Spoke", start, end)) voices.push({ id: Number(e.args.id), from: e.args.from, words: e.args.words });
    for (const e of await body.queryFilter("Fed", start, end)) gifts.push({ id: Number(e.args.giftId), from: e.args.from, usd: microsToUsd(e.args.amount), note: e.args.note });
  }

  const sealed = readJson(SEALED, []);
  const starving = life < floor;
  const situation = {
    now: new Date(now * 1000).toISOString(),
    ageDays: Math.round(((now - Number(bornAt)) / 86400) * 10) / 10,
    lifeUsd: microsToUsd(life),
    floorUsd: microsToUsd(floor),
    starving,
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
  const txs = [];
  const act = async (label, fn) => {
    try {
      const tx = await fn();
      await tx.wait();
      txs.push({ label, hash: tx.hash });
    } catch (err) {
      txs.push({ label, error: String(err.shortMessage || err.message) });
    }
  };

  const voiceIds = new Set(voices.map((v) => v.id));
  for (const r of d.replies || []) {
    if (!voiceIds.has(r.voiceId) || !r.words) continue;
    await act(`say:${r.voiceId}`, () => body.say(fitBytes(r.words, 1000), r.voiceId));
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

  // Pay for this waking: inference plus gas for every transaction, including the meal itself.
  const gasUsd = (txs.length + 1) * GAS_USD_PER_TX;
  let owed = BigInt(state.owedMicros) + usdToMicros(thought.costUsd + gasUsd);
  const [maxPerMeal, maxPerDay, dayStart, spentToday] = await Promise.all([body.maxPerMeal(), body.maxPerDay(), body.dayStart(), body.spentToday()]);
  const spentSoFar = BigInt(now) >= dayStart + 86400n ? 0n : spentToday;
  const allowance = [owed, maxPerMeal, maxPerDay - spentSoFar, life].reduce((a, b) => (b < a ? b : a));

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
    costs: { inferenceUsd: thought.costUsd, gasUsd, owedBeforeUsd: microsToUsd(BigInt(state.owedMicros)), paidNowUsd: microsToUsd(allowance) },
    txs,
  };
  const logBytes = Buffer.from(JSON.stringify(log, null, 2) + "\n");
  fs.writeFileSync(path.join(LOGS, logName), logBytes);
  const logHash = ethers.keccak256(logBytes);
  if (allowance > 0n) {
    await body.metabolize(allowance, logHash).then((tx) => tx.wait());
    owed -= allowance;
  }

  // Last words, only possible once starving (the contract enforces it too).
  const lifeAfter = await body.life();
  if (lifeAfter < floor && d.lastWords) {
    await body.die(fitBytes(d.lastWords, 1000), ethers.toUtf8Bytes(fitBytes(d.seed || "", 2000))).then((tx) => tx.wait());
  }

  const sleepHours = Math.min(72, Math.max(1, d.sleepHours || 6));
  writeJson(STATE, {
    lastBlock: latest,
    nextWakeAt: now + sleepHours * 3600,
    owedMicros: owed.toString(),
    diary: [...state.diary, { at: situation.now, entry: d.diary, log: logName }].slice(-30),
    wakings: state.wakings + 1,
  });
  writeJson(SEALED, sealed);
  console.log(`woke, read ${voices.length} voices, spent $${thought.costUsd.toFixed(4)} thinking, life now $${microsToUsd(lifeAfter)}`);
  return { log: logName, logHash, txs, lifeAfter };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  heartbeat().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
