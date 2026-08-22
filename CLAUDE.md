# CLAUDE.md — Orionscope

Non-custodial agent that finds and reclaims unclaimed on-chain value on **Base (chainId 8453)**.
Scans a wallet across three sources — Clanker creator fees, Merkl incentives, Uniswap v3
uncollected LP fees — and returns a deterministic report; claims permissionless rewards to the
owner and builds owner-signed txs for the rest. Full detail lives in `forgotten-money-agent-spec.md`
— read it before implementing an adapter.

## Stack & conventions

- TypeScript + **viem** only. Do NOT introduce ethers.js.
- Base RPC, chainId `8453`. Keep the RPC URL in env (`BASE_RPC_URL`), never hardcoded.
- Async everywhere; no top-level await in library modules.
- One adapter per source, each implementing the shared `SourceAdapter` interface. Never inline
  a source's logic into the aggregator.
- No secrets in code. No hot private keys for the claim path — owner-sign txs are returned for
  the owner's wallet to sign; permissionless txs are sent from an agent signer only if configured.

## Invariants — do not break these (they are the whole product)

1. **Never fabricate or estimate a claimable amount.** Every `rawAmount` comes from a real
   on-chain read or API call, recorded in `provenance`. If you can't read it, don't list it.
2. **Claim logic always uses `rawAmount` (base units, bigint).** USD is display/ranking only.
3. **`usdValue = null` when there's no reliable price.** Surface as "unpriced." Never invent a
   price for a thin/long-tail token.
4. **The LLM summary only narrates structured data.** It must not compute, round, or alter any
   figure — every number in the brief maps 1:1 to an `UnclaimedItem.provenance`. This "every claim
   traces to a real tool call" property is the differentiator; keep it literally true.
5. **Merkl proofs expire (~4h).** Fetch fresh immediately before building the claim tx; never cache
   across a session. Pass cumulative `amount`, and skip entries where `proofs` is empty or nothing
   is outstanding (they revert the whole tx with `InvalidProof`).
   The outstanding amount is `amount − claimed(user, token)` read FROM THE DISTRIBUTOR, not the
   API's `claimed` field — the API index lags the chain and will advertise entitlements already
   paid out. Also read `claimRecipient(user, token)` / `(user, 0x0)`: a user can redirect payouts,
   and the report must not promise their wallet when the tokens go elsewhere.
   Some campaigns distribute a WRAPPER token that burns itself on receipt and releases the real
   token 1:1 (detect via `token()` + `distributor() == Distributor`, same decimals). Report the
   underlying — it is what the owner receives and the only one with a price — but keep encoding
   the wrapper in the tx, since that is what the proof commits to.
6. **Uniswap v3 owed:** read current fees by static-calling `collect` with uint128-max maximums;
   do not trust `positions().tokensOwed` (stale).

## Verified contract addresses (Base) — use these, never guess

- Clanker v4 core/factory: `0xe85a59c628f7d27878aceb4bf3b35733630083a9`
- ClankerFeeLocker v4.0.0: `0xf3622742b1e446d92e45e22923ef11c2fcd55d68`
- Merkl Distributor: `0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae`
- Uniswap v3 NonfungiblePositionManager: `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`

If a needed ABI/signature isn't in this repo, read the verified source on Base — do not invent
function signatures. BaseScan's API needs a key; `https://base.blockscout.com/api?module=contract&
action=getabi&address=…` (and `getsourcecode`) serves the same verified artifacts without one.
Every ABI in `src/abis/` came from there and records the properties the adapters rely on.

RESOLVED: the ClankerFeeLocker `claim(address feeOwner, address token)` signature is confirmed and
it IS permissionless.

## Adapter cheat-sheet

- **Merkl** (**owner-sign** by default — see below): `GET api.merkl.xyz/v4/users/{owner}/rewards?chainId=8453`
  → `claim(users, tokens, amounts, proofs)` on the Distributor. Build first — fastest slice.
  CORRECTION, verified against the Distributor source: `claim` credits `users[i]` rather than the
  caller, but `_claim` reverts `NotWhitelisted()` unless `msg.sender == user`, `tx.origin == user`,
  or the caller is an approved operator (`operators[user][caller]`, `mainOperators[caller][token]`,
  or governor/guardian). So this source is `owner-sign` until the owner calls
  `toggleOperator(owner, agent)`; the adapter reads those mappings and upgrades to `permissionless`
  only when the approval actually exists.
- **Uniswap v3** (owner-sign): NPM `balanceOf`/`tokenOfOwnerByIndex` → `positions(tokenId)` →
  static-call `collect` for owed → real `collect({recipient: owner, ...})`.
- **Clanker** (permissionless-to-owner, CONFIRMED): read `availableFees(feeOwner, currency)` on the
  ClankerFeeLocker, claim with `claim(feeOwner, currency)`. Both signatures are taken from the
  verified source; `claim` transfers to `feeOwner` with no `msg.sender` check, and a fork test
  confirms a stranger's claim lands in the owner's wallet.
  The `clanker-sdk` is NOT a dependency: the SDK was recommended to avoid hand-rolling Uniswap v4
  fee math, but the FeeLocker's own view function already gives the harvested balance, and pending
  pool fees are read by simulating `collectRewards` rather than by reimplementing v4 accounting.
  Note fees accrue in BOTH pool currencies and the locker is keyed on `(feeOwner, currency)`, not on
  the Clanker token — so NEVER let token enumeration decide whether a currency gets probed. Always
  read the baseline currencies for the owner; a wallet can hold a balance earned on deploys no
  index lists, and gating on "is the owner a recipient of this token" silently reports $0.
  The baseline is still not complete — fees accrue in BOTH pool sides, so an owner earns in tokens
  they never deployed. `--deep` (src/clankerCurrencies.ts) walks `StoreTokens` on the indexed
  `feeOwner` topic for the exact answer. Any scan that partially fails MUST report itself
  incomplete; a silently-partial currency set is the same class of bug as reporting $0. See **CLANKER.md** for the full mechanics — read it before touching this adapter.

## Claim-type semantics

- `permissionless`: agent may submit the claim tx itself; funds still route to the owner. Verify
  this from the contract before claiming it — "the recipient is an argument, not msg.sender" is
  necessary but NOT sufficient (Merkl credits the user and still gates the caller).
- `owner-sign`: agent builds the tx; the owner signs. Non-custodial by construction.
- Group these in any UX: "Auto-claimable now" vs "One-click, needs your signature."

## v1 scope — build ONLY this

Three adapters above + wallet-scan (hero) + Clanker chain-scan. Deterministic engine, thin agent
layer, minimal web UI (reuse the pools.trade dashboard). **Do not** build Aerodrome, airdrop, or
vesting adapters yet, and **do not** build a fee/splitter — monetization is a config constant for v1.

## Pricing

DefiLlama coins API: `GET https://coins.llama.fi/prices/current/base:{token}` (batch). No price → `null`.

## Commands

<!-- Fill in once scaffolded. -->
- Install: `pnpm install`
- Dev: `pnpm dev`
- Test (against a Base mainnet fork): `pnpm test`

## Testing rules

Fork Base mainnet (Anvil), test against wallets with real unclaimed balances. Assert read == received:
`feesToClaim` == amount after Clanker claim; Merkl `amount − claimed` == delta transferred;
Uniswap static-call `collect` == amount from real `collect`. Verify a permissionless claim sent from
a caller ≠ owner still lands in the owner's wallet.