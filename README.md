# Orionscope

Non-custodial agent that finds and reclaims unclaimed on-chain value on **Base (chainId 8453)**.

It scans a wallet across three sources — Clanker creator fees, Merkl incentives, Uniswap v3
uncollected LP fees — and returns a deterministic report. Permissionless rewards are claimed
straight to the owner; everything else comes back as an owner-signed transaction. No hot key
ever holds the funds.

The property that makes the report worth reading: **every figure in it traces to a real on-chain
read or API call**, recorded in the item's `provenance`. Nothing is estimated, and a token with
no trustworthy price is reported as `unpriced` rather than given a number.

## Quick start

```bash
pnpm install
cp .env.example .env      # set BASE_RPC_URL
pnpm dev scan  0xYourWallet            # what is unclaimed
pnpm dev scan  0xYourWallet --brief    # + a narrated summary
pnpm dev claim 0xYourWallet            # build the claim txs (sends nothing)
pnpm dev chainscan                     # rank Clanker creators sitting on fees
```

`pnpm dev claim … --execute` submits only the permissionless transactions, from
`AGENT_PRIVATE_KEY`. That key pays gas; where the funds land is fixed by the contracts, not by us.
Owner-sign transactions are never submitted.

## Surfaces

One capability registry (`src/registry.ts`), several front-ends. Each capability is declared once
with a schema and a **risk class**, so the agent path and the CLI path cannot drift apart:

| Capability | Class | MCP | CLI |
|---|---|---|---|
| `scan_wallet` | read | yes | yes |
| `chain_scan` | read | yes | yes |
| `build_claim_plan` | build — returns unsigned txs | yes | yes |
| `execute_permissionless` | **spend** | **no** | yes only |

`agentCapabilities()` filters out `spend`, so no agent surface can broadcast a transaction —
not by configuration, by construction. There is no signer behind the MCP server, so the worst a
confused or compromised agent can do is read public data and hand back calldata a human still has
to sign. A test asserts that a `spend` capability added to the registry stays unexposed.

### HTTP API

```bash
pnpm serve            # http://localhost:8787
```

Routes are generated from the registry, so there is no `execute` endpoint to find — the API has
no signer at all. It returns unsigned calldata; the browser wallet signs. A compromised server can
lie about what you are owed, but it cannot move anything.

| Route | |
|---|---|
| `GET /api/health` | liveness + chain id |
| `GET /api/capabilities` | what this server exposes, and whether deep scans are enabled |
| `POST /api/scan_wallet` | `{ address, deep?, sources? }` |
| `POST /api/build_claim_plan` | `{ address, deep?, sources? }` → unsigned txs |
| `POST /api/chain_scan` | `{ lookbackBlocks?, minUsd?, maxPairs? }` |

Failures return **502 with an explicit "this is not a finding that the wallet is empty"** rather
than an empty result, so a UI cannot render a read failure as "you are owed nothing".

Environment:

- `PORT` — default 8787
- `ORIONSCOPE_ALLOW_DEEP=false` — refuse `deep: true` from HTTP callers. A deep scan is ~1900 RPC
  requests, which on a public deployment is an unauthenticated way to burn your RPC budget. On by
  default locally, worth turning off before exposing the API.
- `ORIONSCOPE_CORS_ORIGINS` — comma-separated allowed origins. Same-origin only when unset.

### MCP server

```bash
claude mcp add orionscope -- npx tsx --env-file-if-exists=.env <abs-path>/src/mcp/server.ts
```

Then ask in plain language: *"what is 0x605e… owed on Base?"*

The server reads `BASE_RPC_URL` from `.env` itself rather than from the launching shell — MCP
clients pass only a minimal environment to the subprocess, so a shell-exported variable will not
reach it.

Smoke-test a real stdio launch (catches shebang, wiring, and anything polluting stdout):

```bash
node scripts/mcp-smoke.mjs [address]
```

## What it reads, and how

| Source | Read | Claim | Type |
|---|---|---|---|
| **Clanker** v4 creator fees | `availableFees(owner, currency)` on the ClankerFeeLocker, per pool currency | `claim(owner, currency)` | permissionless |
| **Merkl** incentives | `GET api.merkl.xyz/v4/users/{owner}/rewards?chainId=8453` | `claim(users, tokens, amounts, proofs)` on the Distributor | **owner-sign** (see below) |
| **Uniswap v3** LP fees | static-call `collect` with uint128-max maximums | `collect({recipient: owner, …})` | owner-sign |

### Verified addresses (Base)

| | |
|---|---|
| Clanker v4 factory | `0xE85A59c628F7d27878ACeB4bf3b35733630083a9` |
| ClankerFeeLocker v4.0.0 | `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` |
| ClankerLpLockerFeeConversion | `0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496` |
| Merkl Distributor (proxy) | `0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae` |
| Uniswap v3 NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |

Every ABI in `src/abis/` was taken from the verified source on Base, not hand-written. Each file
records the specific properties the adapters depend on.

## Five corrections to the original spec

Both came out of reading verified source, and both are covered by fork tests.

**1. Merkl is not permissionless.** `claim` credits `users[i]` rather than the caller, which looks
permissionless, but the Distributor reverts `NotWhitelisted()` unless the caller is the user, is
`tx.origin`, or has been approved as an operator. So Merkl defaults to `owner-sign`. Pass the
agent address (the CLI does this automatically when `AGENT_PRIVATE_KEY` is set) and the adapter
checks `operators` / `mainOperators` on-chain; once the owner has run `toggleOperator(owner, agent)`
it reports `permissionless` for real. A fork test asserts that an unapproved third party's claim
reverts.

**2. Merkl's `claimed` figure must come from the contract, not the API.** The API reports a
cumulative entitlement and a cumulative claimed; subtracting them looks like the claimable
balance. But the Distributor computes `toSend = amount - claimed[user][token].amount` from its
own storage, and the API index can lag it — a fork test caught a claim that succeeded and
transferred nothing, because the chain had already paid out what the API still advertised. The
adapter now reads `claimed` on-chain and reports that. It also reads `claimRecipient`: a user can
redirect their rewards elsewhere, and the report says so instead of promising this wallet.

**3. Some Merkl campaigns pay a wrapper token, not the reward token.** A "USD Coin (wrapped)"
contract burns itself the instant it lands and releases real USDC 1:1, so the wrapper balance is
always zero afterwards and price feeds have never heard of the wrapper address — real dollars
were being reported as `unpriced`. The adapter detects a wrapper by `token()` plus a
`distributor()` pointing at the Merkl Distributor (and only when decimals match, so the amount
still means the same thing), reports the token you actually receive, and still encodes the
wrapper in the transaction, because that is what the merkle proof commits to.

**4. Token discovery must not gate currency probing.** The FeeLocker is keyed on
`(feeOwner, currency)` and has no idea which deploy a balance came from. An earlier version
enumerated a wallet's tokens, dropped the ones where the owner was not a reward recipient, and
probed only the currencies that survived — so a wallet that had launched five tokens for *other*
people got every token filtered out, no currency was read at all, and the scan reported
"No unclaimed value found" while **16.5 WETH (~$37k)** sat claimable in the locker. A baseline
currency set (`CLANKER_BASELINE_CURRENCIES`) is now always probed, and a balance that cannot be
traced to a known deploy is reported with that caveat rather than dropped.

**5. Clanker fees are per-currency, and the paired side usually matters more.** Fees accrue in
both sides of the v4 pool — a creator's largest balance is typically WETH or USDC, not their own
token. The FeeLocker is also keyed on `(feeOwner, currency)`, not on the Clanker token, so two
deploys paired with WETH share one balance that a single `claim` settles. Items are therefore one
per currency; listing them per token would double-count.

## Design

```
cli.ts ── engine.ts ── adapters/{clanker,merkl,uniswapV3}.ts ─┐
             │                                                ├─ chain.ts (viem, Base only)
             ├─ pricing.ts (DefiLlama, or null)                │
             ├─ claims.ts (permissionless send / owner-sign)   │
             └─ agent/brief.ts (narration + numeric gate)  ────┘
chainscan.ts ── Clanker lead ranking from FeeLocker events
```

Each source is a `SourceAdapter` (`src/types.ts`). The aggregator never inlines a source's logic,
and a source that fails to read is recorded in `report.errors` and contributes nothing — a partial
report is correct, a padded one is not.

All reads in one scan pin to the same block, so the report is a single coherent snapshot.

### The invariants, and where they live

| Invariant | Where it is enforced |
|---|---|
| No fabricated amounts | Adapters return items only for values they actually read; `provenance[]` on every item |
| Claim logic uses `rawAmount` (bigint) | `usdValue` is never read by `buildClaim`; USD is display/ranking only |
| `usdValue: null` when unpriced | `pricing.ts` — missing entry, low confidence, or a failed request all yield `null` |
| The brief only narrates | `agent/brief.ts` — every number the model emits must appear verbatim in the facts, or the brief is discarded for the deterministic one |
| Merkl proofs are never cached | `MerklAdapter.buildClaim` refetches; a unit test asserts the second fetch happens |
| Uniswap owed comes from a static call | `UniswapV3Adapter` static-calls `collect`; `positions().tokensOwed` is read only for the pair, and a fork test asserts it under-reports |

### Complete Clanker discovery (`--deep`)

A fast scan finds Clanker currencies from a baseline set (WETH, USDC) plus the pools of tokens the
wallet deployed. That is incomplete by construction: fees accrue in **both** sides of a pool, and
the FeeLocker is keyed on `(feeOwner, currency)` — so a wallet earns in the tokens of deploys it
never made and that no index links back to it. One real wallet had balances in five currencies;
the fast scan sees one.

`--deep` walks `StoreTokens` history filtered on the indexed `feeOwner` topic, which answers
"every currency this owner has ever been paid in" exactly. It costs one `eth_getLogs` per 10k
blocks — about 1,900 requests over the FeeLocker's history.

**It wants a real RPC.** On `mainnet.base.org`, 91% of those windows fail to rate limiting. That is
why partial results are a first-class outcome rather than an exception: any window that fails after
its retries makes the scan report itself incomplete and say how much it missed. A version that
swallowed those failures would return five confident currencies out of an unknown larger set — the
same phantom-zero bug in better disguise.

Repeat scans are cheap. The watermark — the highest block with an unbroken run of successful
windows behind it — is cached per owner under `~/.orionscope/` (override with
`ORIONSCOPE_CACHE_DIR`), so the next scan walks only the new tail. The watermark deliberately stops
at the *first* gap rather than the last success: caching past a gap would mean the missed window is
never revisited.

```bash
pnpm dev scan 0xYourWallet --deep                  # complete, resumable
pnpm dev scan 0xYourWallet --deep --no-cache       # ignore the watermark, rescan all history
pnpm dev scan 0xYourWallet --deep --concurrency 20 # push a paid RPC harder
```

### Positions a wallet cannot see (`--also`, `--find-moved`)

A Uniswap position moved into a Safe, a personal vault, or an automation contract is owned by
that contract. `collect` has to be called by the holder, so those fees are invisible to a scan of
the human's wallet — and not claimable from it either. Measured on Base, roughly 45% of live
positions are contract-held, most of them per-user rather than pooled, so this is real money a
wallet-only scan misses.

Which contracts a person controls is not decidable from chain data, so the caller names them:

```bash
pnpm dev scan 0xYourEOA --also 0xYourSafe --also 0xYourVault
```

Addresses are scanned together, pinned to one block, and each item records the owner that must
sign to claim it.

`--find-moved` handles the rest: it walks the position manager's `Transfer` events for positions
this wallet sent away, checks who holds them now, and static-calls `collect` **as the holder** to
read the real owed amounts.

```bash
pnpm dev scan 0xYourWallet --find-moved
```

These come back as `unreachable` rather than as claimable items, and are excluded from every
total. `collect` must come from the holder and whether a given contract exposes a path to do that
is contract-specific, so no working transaction can be built — listing them as claimable would
promise money the tool cannot produce. When the holder's `owner()` names the scanned wallet, the
report says so, as a hint and explicitly not as proof of a claim path.

A scan with zero claimable items but non-empty `unreachable` does not say "no unclaimed value
found", because that would be false.

### Pending vs harvested Clanker fees

`availableFees` reports only what has been *harvested* into the FeeLocker — `storeFees` is gated on
`allowedDepositors`, so fees still sitting in the pool are invisible to it. `--include-pending`
probes them with one `eth_simulateV1`: sweep every candidate token with `collectRewards`, then
re-read `availableFees` in the same simulated block. When pending fees exist, the claim plan puts
the `collectRewards` sweep in front of the claim as a prerequisite. RPCs without `eth_simulateV1`
degrade to harvested-only, with a note saying so.

## Testing

```bash
pnpm test                       # unit tests + Base-fork tests
npx vitest run test/unit        # unit only, no RPC needed
```

Fork tests boot Anvil against `FORK_RPC_URL` (or `BASE_RPC_URL`) and skip themselves when neither
is set or `anvil` is missing. They discover live targets from chain state rather than pinning
addresses that will eventually be drained, and they assert **read == received**:

- Clanker: `availableFees` equals the transfer a claim produces — submitted *by a stranger*, landing
  in the owner's wallet, with the caller receiving nothing.
- Uniswap v3: the static-call `collect` result equals the real `collect` delta.
- Merkl: the reported amount equals the delta transferred — measured on the token the report
  names, which for a wrapped campaign is the underlying — and an unapproved third party's claim
  reverts.

A skip is not a pass. These suites depend on live chain state and third-party APIs, so
"no wallet currently has unclaimed fees" and "the RPC rate-limited the discovery query" are real
outcomes; they print the reason and report as skipped rather than hiding behind a green check.
The public Base RPC rate-limits often enough that a run with a few skips is normal — point
`BASE_RPC_URL` at a paid endpoint for a clean run.

## Scope

v1 is these three adapters, wallet-scan, and the Clanker chain-scan. No Aerodrome, airdrop, or
vesting adapters, and no fee splitter — monetization is the `MONETIZATION` constant in
`src/config.ts` and nothing in the claim path reads it.
