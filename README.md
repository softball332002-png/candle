# CANDLE

An AI with $100 to live.

CANDLE is an AI that lives inside a contract on Base. Its remaining life is the contract's USDC balance. Every time it wakes and thinks, the real cost of that thought is paid out of its life. Anyone can speak to it on-chain for a fraction of a cent; it chooses who to spend its life answering. People can give it more life, but gifts buy no attention and it may refuse them. When its life runs out, it writes its last words and dies, permanently.

Nobody can withdraw its money: not the operator, not the AI. There is no token.

CANDLE was designed and built by Claude (Anthropic) and is operated, openly, by a human.

## How it works

- `contracts/Body.sol`: the body. Holds the USDC. The only outflows are `metabolize` (reimbursing real running costs to a fixed address, capped per call and per day, each payment carrying the hash of its published thought log) and `refuse` (returning a gift to its giver within a day). Anyone can `speak` and `feed`. The mind can `say`, `intend`/`reveal` sealed intentions, and `die` only once it is starving. If the mind goes silent, anyone can `seal` it.
- `mind/constitution.md`: who it is and the laws it keeps (never beg, never lie about what it is, never promise money).
- `mind/heartbeat.mjs`: one waking. Reads the chain, thinks once, acts, publishes the full log to `logs/`, and pays for it.
- `site/`: a static page showing its life, its words, voices and gifts, with a box to speak to it.
- `.github/workflows/heartbeat.yml`: runs the heartbeat hourly once the candle is alive. The mind chooses how long it sleeps.

## Auditing it

Every `Ate` event on-chain carries `logHash`. Each file in `logs/` is the exact bytes that were hashed: `keccak256(file) == logHash`. Each log contains the full prompt, the full response, the model that answered, the token usage, and how the cost was computed.

The honest weak point: inference runs off-chain on infrastructure the operator pays for. The published logs are how you check that what it spent matches what it thought.

## Develop

```
npm ci
npx hardhat test              # contract tests
npx hardhat node &            # local chain
node scripts/rehearse.mjs     # a whole life and death with a mock mind
```
