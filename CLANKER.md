# CLANKER.md — Clanker adapter mechanics (Base)

Authoritative mechanics for the Clanker source. Supersedes the Clanker sections of
`forgotten-money-agent-spec.md` and `CLAUDE.md` where they conflict. Read this before
implementing the Clanker adapter.

## TL;DR — implemented against verified contracts, no SDK

**Status: built and fork-tested. `clanker-sdk` is not a dependency.**

The SDK was recommended to avoid hand-rolling Uniswap v4 fee math. It turned out not to be
needed: the FeeLocker's own `availableFees` view already returns the harvested balance, and
pending pool fees are obtained by *simulating* the existing `collectRewards` sweep rather than
reimplementing v4 accounting. That avoids depending on SDK method names that can move between
majors, and every signature used is copied from verified on-chain source.

- Read harvested: `availableFees(feeOwner, currency)` on the ClankerFeeLocker
- Read pending: one `eth_simulateV1` — `collectRewards(token)` on the LP locker, then re-read
  `availableFees` in the same simulated block; the delta is what a sweep would add
- Claim: `claim(feeOwner, currency)` on the FeeLocker — permissionless, funds go to `feeOwner`

Verified ABIs live in `src/abis/clankerFeeLocker.ts` and `src/abis/clankerLpLocker.ts`.

### Two things the original mechanics write-up missed

1. **Fees accrue in BOTH pool currencies.** A creator's largest balance is usually the paired
   token (WETH/USDC), not their own token. Read the pool key from
   `tokenRewards(token).poolKey` and check `currency0` and `currency1` as well.
2. **The FeeLocker is keyed on `(feeOwner, currency)`, not on the Clanker token.** Two deploys
   both paired with WETH share ONE WETH balance, and a single `claim` settles all of it. Report
   one item per currency — per-token items double-count.

## Fee model (what "unclaimed" actually means here)

- On a standard v4 deploy, the full token supply goes into a single-sided Uniswap v4 LP (the
  "initial LP"). Every swap accrues LP fees on that position.
- Clanker takes a fixed 20% protocol cut of LP fees; the rest flows to up to 7 configurable
  **reward recipients** (the creator and any splits they set). clanker.world-frontend deploys
  route all initial-LP fees to the creator; Farcaster @clanker-bot deploys give the creator 80%.
- Fees are auto-collected on swaps by the hook and distributed via the LP locker into the
  **ClankerFeeLocker**, which holds per-recipient, per-token balances until claimed.
- Two layers of "unclaimed" therefore exist:
  1. **Harvested** — already sitting in the FeeLocker (`feesToClaim[recipient][token]`).
  2. **Pending** — accrued in the pool, not yet swept into the locker.
  `availableFees`/`feesToClaim` cover harvested only; pending needs the simulated sweep (Read path).

## Deployed contracts (Base) — current v4.0.0

- Clanker core/factory: `0xE85A59c628F7d27878ACeB4bf3b35733630083a9`
- ClankerFeeLocker: `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68`
- ClankerLpLockerFeeConversion (v4 LP locker): `0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496`

FeeLocker shape (verified source): `mapping(address feeOwner => mapping(address token => uint256))
public feesToClaim;` and `storeFees` restricted to `allowedDepositors` (the LP locker/hook).
So `feesToClaim` reflects **harvested** balances only.

REST API base: `https://www.clanker.world/api` (schema at clanker.world/docs/api-registry.ts).

## Claim path (permissionless-to-owner) — CONFIRMED

`claim(address feeOwner, address token)` on the FeeLocker. From the verified source:

```solidity
// claim fees on behalf of a feeOwner
function claim(address feeOwner, address token) external nonReentrant {
    uint256 balance = feesToClaim[feeOwner][token];
    if (balance == 0) revert NoFeesToClaim();
    feesToClaim[feeOwner][token] = 0;
    SafeERC20.safeTransfer(IERC20(token), feeOwner, balance);
    emit ClaimTokens(feeOwner, token, balance);
}
```

No `msg.sender` check, and the transfer goes to `feeOwner`. Permissionless, confirmed on a fork by
claiming from a stranger address and watching the funds land in the owner's wallet.

Note `NoFeesToClaim()` on a zero balance — filter zero-balance entries before building a tx, the
same class of bug as Merkl's empty proofs.

A `collectRewards(token)` sweep is only needed when pending pool fees exist; `claim` does not
harvest. The adapter emits the sweep as a prerequisite tx, ordered ahead of the claim, and only
when the pending probe actually saw something.

## Read path

1. `availableFees(feeOwner, currency)` on the FeeLocker — harvested balances. Identical to reading
   the public `feesToClaim` mapping; `availableFees` is just the named view over it.
2. Pending (pool-side) fees: `eth_simulateV1` with `collectRewards(token)` followed by
   `availableFees(feeOwner, currency)` in the same simulated block. Falls back to harvested-only,
   with a note on the report, when the RPC lacks `eth_simulateV1`.
3. Confirm the owner is really a recipient with `tokenRewards(token).rewardRecipients` — the REST
   API's recipient list can lag an on-chain `updateRewardRecipient`.

## Enumeration — which tokens has an owner earned on?

You can't cheaply iterate all Clanker tokens. In priority order:

1. **REST API** — `GET https://www.clanker.world/api/tokens/fetch-deployed-by-address?address=X`
   (`&page=&limit=`, **limit caps at 20** — higher returns a 400). Confirmed working. It indexes the
   DEPLOYER, so it misses tokens where the wallet is only a split recipient on someone else's
   deploy; pass those explicitly with `--token`. There is no per-recipient filter: `?rewardRecipient=`
   is silently ignored and returns the unfiltered list.
   Each record carries `extensions.fees.recipients[]` (bps + recipient) and `pool_config.pairedToken`,
   but treat the on-chain `tokenRewards` read as authoritative.
2. **Event indexing fallback** — index Clanker deploy + reward-recipient events to build a
   `recipient → tokens[]` map, then read `availableFees` per (recipient, currency).

## Chain-scan (lead ranking) — the second demo

**Do not use the REST "recent tokens" feed as the universe.** It is ordered by deploy time, and a
token deployed an hour ago has no fees for anyone to be sitting on — an early version of the scan
walked 60 fresh deploys and found nothing at all.

The universe is the FeeLocker's own events instead: every harvest emits
`StoreTokens(sender, feeOwner, token, balance, amount)`, so those events ARE the set of
(recipient, currency) pairs that have earned something.

- Walk `StoreTokens` over a lookback window → candidate pairs (public Base RPCs reject
  `eth_getLogs` spans much above 10k blocks, so chunk it).
- `availableFees` per pair for the live balance, price via DefiLlama, rank by USD.
- Walk `ClaimTokens` over the same window; a pair with accrual and no claim is the lead.

Implemented in `src/chainscan.ts`. A ~4k-block window surfaces real five-figure balances.

## v3 vs v4

- This adapter targets **v4** (current). v0–v3.1 tokens use a different, legacy fee-claim path
  ("Legacy Fee Claims" in the SDK; v3 tokens collect via the Uniswap v3 NonfungiblePositionManager).
- Don't try to unify v3 and v4 in v1. If a scanned token is pre-v4, mark it "legacy — not supported"
  rather than mis-claiming against the wrong contract.

## Open items — all closed

1. **Does the read include pending fees?** No. `availableFees` / `feesToClaim` are harvested only —
   `storeFees` is gated on `allowedDepositors`, so pool-side fees never reach the locker until a
   sweep. Pending is read separately via the `eth_simulateV1` probe above. In practice the hook
   auto-collects on swaps, so on the wallets tested the pending delta was zero; do not rely on that.
2. **Does claim auto-harvest?** No. `claim` only moves what is already in the locker. Sweep first
   with `collectRewards(token)` when pending fees exist.
3. **FeeLocker `claim` signature, callable by a non-recipient?** `claim(address feeOwner, address
   token)`, and yes — verified in source and on a fork.
4. **REST endpoint for per-owner tokens?** `/api/tokens/fetch-deployed-by-address?address=X`, with
   the caveats in the Enumeration section.