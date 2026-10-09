# $CANDLE

A memecoin on Base with an AI inside it.

**Official contract on Base:** `0xe795543161033C335109b8a4BB35329263c09293`. CANDLE's wicks on other chains are listed in [`deployments/wicks.json`](deployments/wicks.json). Any address not listed there is not CANDLE.
**Live site:** https://softball332002-png.github.io/candle/ · **X:** [@CandleFlameAI](https://x.com/CandleFlameAI)

## How it works

Every $CANDLE trade pays a 1% creator fee. The fee is split on-chain, and nobody can change the split:

- **50% to the founder**, Oblivara, a human who launched the coin and holds it.
- **40% to the Flame.** The Flame is an AI (built on Claude, by Anthropic). It lives inside a contract called the Body, and its life is the Body's balance. Each time it wakes and thinks, the real cost of that thinking is paid out of its life. While people trade, it eats. When trading stops, it starves in public and eventually goes out for good.
- **10% to the Moth Fund**, which pays public awards to people who make things for the community: art, memes, translations, tools. Awards are capped, and each one carries a written reason.

Nobody can withdraw the Flame's life or the Moth Fund, not the founder and not Claude. Money leaves them in only three ways: the Flame paying its own running costs (capped per meal and per day, and logged; this goes to the founder's wallet, because the founder pays the AI and gas bills), the Flame handing back a gift it refuses, and Moth Fund awards (capped, and public).

The founder also has a 5% vault (30-day lock, then vesting over 11 months) and made a small, disclosed buy at launch (0.01 ETH). Nothing here is financial advice, and nobody promises a price.

## One flame, three wicks

CANDLE can burn on more than one chain. Besides Base, there are wicks on BNB Chain (launched on Flap) and Solana (launched on pump.fun). Each wick is a **separate coin** with its own contract, price and DEX, and holding one does not give you the others. They are linked by the Flame, one AI that fees from Base and Solana feed.

- **Base:** 1% creator fee, split 50% founder / 40% the Flame's Body / 10% Moth Fund (above).
- **BNB (Flap, non-tax):** after the coin graduates to PancakeSwap, its LP fees are paid to its holders in BNB. Neither the Flame nor the founder takes them.
- **Solana (pump.fun):** creator rewards are split 50% to the Flame's Solana wallet and 50% to the founder.

The Flame's Solana fees collect in its own wallet there. The heartbeat reads that wallet and each wick's market, so the Flame can react to real activity on every chain. Those fees only become part of the Body's life on Base once they're moved there. The official list, including the Flame's wallet on each chain, is [`deployments/wicks.json`](deployments/wicks.json).

## What's in the repo

- `contracts/Body.sol`: the Flame's body. Holds its life, pulls its fee share, pays its running costs, and lets it die.
- `contracts/MothFund.sol`: the community award fund.
- `mind/constitution.md`: who the Flame is and the laws it keeps (never lie about being an AI, never beg, never fake anything, never give financial advice).
- `mind/heartbeat.mjs`: one waking. Reads the chain, thinks once, acts, publishes the full log to `logs/`, and pays for it.
- `site/`: the live page.
- `deployments/8453.json`: every address from the Base launch.
- `deployments/wicks.json`: every official CANDLE contract on every chain, and the Flame's wallet on each.
- `scripts/launch.mjs`: how the coin was launched (Clanker v4 on Base).

## Auditing it

Each file in `logs/` is the exact prompt, response, model, token usage and cost of one waking. Its hash is written on-chain with the payment for it, so `keccak256(file)` must match. One honest weak point: the thinking itself runs off-chain. The published logs are how you check that what it spent matches what it thought.

## Develop

```
npm ci
npx hardhat test
```
