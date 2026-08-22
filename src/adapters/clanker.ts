import { encodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from "viem";
import { clankerFeeLockerAbi } from "../abis/clankerFeeLocker.js";
import { clankerLpLockerAbi } from "../abis/clankerLpLocker.js";
import { ADDRESSES, CLANKER_BASELINE_CURRENCIES } from "../config.js";
import { discoverFeeCurrencies, type CurrencyDiscovery } from "../clankerCurrencies.js";
import { loadCursor, saveCursor } from "../cursorCache.js";
import { apiRewardRecipients, fetchTokensDeployedBy, isOnBase, isV4 } from "../clankerApi.js";
import { contractRead, httpRead, staticCall } from "../provenance.js";
import { loadTokenInfo } from "../tokens.js";
import type { ClaimTx, ScanContext, SourceAdapter, SourceNote, UnclaimedItem } from "../types.js";

const FEE_LOCKER = ADDRESSES.clankerFeeLocker;
const LP_LOCKER = ADDRESSES.clankerLpLocker;

export interface ClankerAdapterOptions {
  /** Extra Clanker tokens to check — covers split-recipient deploys the REST index misses. */
  tokens?: Address[];
  /**
   * Also probe pool-side ("pending") fees by simulating a harvest. Needs an RPC
   * with eth_simulateV1; degrades to harvested-only, with a note, if unsupported.
   */
  includePending?: boolean;
  maxPages?: number;
  fetchImpl?: typeof fetch;
  /**
   * Walk `StoreTokens` history to find every currency this owner has ever been
   * paid in, instead of relying on the baseline set plus token discovery. This
   * is the only complete answer; it costs one `eth_getLogs` per 10k blocks.
   */
  deep?: boolean;
  /** Parallel log requests during a deep scan. */
  deepConcurrency?: number;
  /** Resume from (and update) the on-disk watermark. Default true when deep. */
  useCache?: boolean;
  onDeepProgress?: (done: number, total: number, failed: number) => void;
}

/** A Clanker deploy the owner is a reward recipient on. */
interface Position {
  /** The Clanker token itself. */
  clankerToken: Address;
  /** Both sides of the v4 pool — fees accrue in either. */
  currencies: Address[];
}

/**
 * Clanker v4 creator fees.
 *
 * Two things about this source drive the shape of the adapter:
 *
 * 1. Fees accrue in BOTH sides of the pool. A creator's biggest balance is
 *    usually the paired currency (WETH/USDC), not their own token — so the pool
 *    key is read from the LP locker and both currencies are checked.
 * 2. The FeeLocker's balance is keyed on (feeOwner, currency), NOT on the
 *    Clanker token. Two deploys both paired with WETH share one WETH balance,
 *    and one `claim` settles all of it. Items are therefore one-per-currency;
 *    listing them per token would double-count and over-report.
 *
 * "Unclaimed" also has two layers:
 *  - HARVESTED — already in the FeeLocker. `availableFees` reads it; one call claims it.
 *  - PENDING — still in the Uniswap v4 pool. Invisible to the FeeLocker, because
 *    `storeFees` is gated on `allowedDepositors`. Probed by simulating
 *    `collectRewards` and re-reading `availableFees` in the same simulated block.
 *
 * Claim type is permissionless, verified rather than assumed: the FeeLocker's
 * `claim(feeOwner, token)` takes the owner explicitly and transfers to that
 * owner with no msg.sender check. See src/abis/clankerFeeLocker.ts.
 *
 * v0-v3.1 tokens use a legacy claim path and are reported as unsupported rather
 * than claimed against the wrong contract.
 */
export class ClankerAdapter implements SourceAdapter {
  readonly id = "clanker" as const;
  readonly claimType = "permissionless" as const;

  constructor(
    private readonly client: PublicClient,
    private readonly options: ClankerAdapterOptions = {},
  ) {}

  /** Clanker tokens worth checking for this owner, from the REST index + explicit list. */
  private async candidateTokens(
    ctx: ScanContext,
  ): Promise<{ tokens: Address[]; paired: Address[]; notes: SourceNote[]; apiUrl: string | null }> {
    const notes: SourceNote[] = [];
    const set = new Set<string>();
    const paired = new Set<string>();
    for (const t of this.options.tokens ?? []) set.add(getAddress(t).toLowerCase());

    let apiUrl: string | null = null;
    try {
      const { tokens, url } = await fetchTokensDeployedBy(ctx.owner, {
        maxPages: this.options.maxPages ?? 4,
        fetchImpl: this.options.fetchImpl,
      });
      apiUrl = url;

      const legacy: string[] = [];
      const ownerKey = ctx.owner.toLowerCase();
      for (const token of tokens) {
        if (!isOnBase(token)) continue;
        const address = getAddress(token.contract_address).toLowerCase();
        if (!isV4(token)) {
          legacy.push(`${token.symbol ?? address} (${token.type ?? "unknown"})`);
          continue;
        }
        // Every deploy contributes its paired currency to the probe set, even
        // when the owner is not a recipient on THIS token — the currency may
        // still hold a balance earned elsewhere, and probing it is nearly free.
        const pairedToken = token.pool_config?.pairedToken;
        if (pairedToken) paired.add(getAddress(pairedToken).toLowerCase());

        // Deployer-indexed. Keep it when the API shows the owner as a recipient,
        // or shows no split at all; the on-chain pool read filters the rest.
        const recipients = apiRewardRecipients(token);
        if (recipients.length === 0 || recipients.includes(ownerKey)) set.add(address);
      }

      if (legacy.length > 0) {
        notes.push({
          source: this.id,
          message:
            `${legacy.length} pre-v4 Clanker token(s) skipped — legacy fee path, not supported in v1: ` +
            legacy.slice(0, 10).join(", ") + (legacy.length > 10 ? ", ..." : ""),
        });
      }
    } catch (err) {
      notes.push({
        source: this.id,
        message:
          `Clanker token enumeration via clanker.world failed (${(err as Error).message}). ` +
          `Only explicitly passed tokens were checked — this scan may be incomplete.`,
      });
    }

    return {
      tokens: [...set].map((a) => getAddress(a)),
      paired: [...paired].map((a) => getAddress(a)),
      notes,
      apiUrl,
    };
  }

  /**
   * Confirm the owner really is a reward recipient on-chain, and pull the pool's
   * two currencies. The API's recipient list can lag `updateRewardRecipient`;
   * `tokenRewards` cannot.
   */
  private async readPositions(ctx: ScanContext, tokens: Address[]): Promise<Position[]> {
    if (tokens.length === 0) return [];
    const results = await this.client.multicall({
      contracts: tokens.map((token) => ({
        address: LP_LOCKER,
        abi: clankerLpLockerAbi,
        functionName: "tokenRewards" as const,
        args: [token] as const,
      })),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    });

    const ownerKey = ctx.owner.toLowerCase();
    const positions: Position[] = [];
    tokens.forEach((clankerToken, i) => {
      const r = results[i];
      if (r?.status !== "success") return;
      const info = r.result as {
        poolKey: { currency0: Address; currency1: Address };
        rewardRecipients: readonly Address[];
      };
      if (!info.rewardRecipients.some((a) => a.toLowerCase() === ownerKey)) return;

      const currencies = [clankerToken, info.poolKey.currency0, info.poolKey.currency1]
        .filter((c) => c && c !== zeroAddress) // native ETH is not held by the FeeLocker
        .map((c) => getAddress(c));
      positions.push({ clankerToken, currencies: [...new Set(currencies)] });
    });
    return positions;
  }

  /**
   * Harvested + optionally pending balances, per currency.
   *
   * The pending probe runs one eth_simulateV1: sweep every candidate token, then
   * re-read every currency in the same simulated block. Total minus harvested is
   * what a sweep would add.
   */
  private async readBalances(
    ctx: ScanContext,
    currencies: Address[],
    positions: Position[],
  ): Promise<{
    harvested: Map<string, bigint>;
    pending: Map<string, bigint>;
    pendingProbed: boolean;
  }> {
    const harvested = new Map<string, bigint>();
    if (currencies.length === 0) return { harvested, pending: new Map(), pendingProbed: false };

    const results = await this.client.multicall({
      contracts: currencies.map((currency) => ({
        address: FEE_LOCKER,
        abi: clankerFeeLockerAbi,
        functionName: "availableFees" as const,
        args: [ctx.owner, currency] as const,
      })),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    });
    currencies.forEach((currency, i) => {
      const r = results[i];
      if (r?.status === "success") harvested.set(currency.toLowerCase(), r.result as bigint);
    });

    const pending = new Map<string, bigint>();
    if (!this.options.includePending) return { harvested, pending, pendingProbed: false };

    try {
      const sweeps = positions.map((p) => ({
        to: LP_LOCKER,
        abi: clankerLpLockerAbi,
        functionName: "collectRewards" as const,
        args: [p.clankerToken] as const,
      }));
      const reads = currencies.map((currency) => ({
        to: FEE_LOCKER,
        abi: clankerFeeLockerAbi,
        functionName: "availableFees" as const,
        args: [ctx.owner, currency] as const,
      }));
      const { results: simulated } = await this.client.simulateCalls({
        account: ctx.owner,
        blockNumber: ctx.blockNumber,
        calls: [...sweeps, ...reads],
      });

      currencies.forEach((currency, i) => {
        const r = simulated[sweeps.length + i];
        if (!r || r.status !== "success") return;
        const total = r.result as bigint;
        const before = harvested.get(currency.toLowerCase()) ?? 0n;
        pending.set(currency.toLowerCase(), total > before ? total - before : 0n);
      });
      return { harvested, pending, pendingProbed: true };
    } catch {
      return { harvested, pending: new Map(), pendingProbed: false };
    }
  }

  /**
   * Full currency discovery, resumed from the cached watermark when possible.
   * Returns the discovery alongside everything previously known for this owner,
   * so a resumed scan still reports currencies found on earlier runs.
   */
  private async deepCurrencies(
    ctx: ScanContext,
  ): Promise<{ currencies: Address[]; discovery: CurrencyDiscovery; resumedFrom: bigint | null }> {
    const useCache = this.options.useCache ?? true;
    const cached = useCache ? loadCursor(ctx.owner) : null;
    const resumedFrom = cached ? BigInt(cached.cursor) : null;

    const discovery = await discoverFeeCurrencies(this.client, ctx.owner, {
      ...(resumedFrom !== null ? { fromBlock: resumedFrom + 1n } : {}),
      toBlock: ctx.blockNumber,
      ...(this.options.deepConcurrency ? { concurrency: this.options.deepConcurrency } : {}),
      ...(this.options.onDeepProgress ? { onProgress: this.options.onDeepProgress } : {}),
    });

    const known = (cached?.currencies ?? []).map((c) => getAddress(c));
    const currencies = [...new Set([...known, ...discovery.currencies].map((c) => c.toLowerCase()))].map(
      (c) => getAddress(c),
    );

    if (useCache) saveCursor(ctx.owner, { watermark: discovery.watermark, currencies });
    return { currencies, discovery, resumedFrom };
  }

  async scan(ctx: ScanContext): Promise<{ items: UnclaimedItem[]; notes?: SourceNote[] }> {
    const { tokens, paired, notes, apiUrl } = await this.candidateTokens(ctx);

    // Positions tell us which pools to SWEEP and which extra currencies exist.
    // They must not decide whether we look at a currency at all: the FeeLocker
    // is keyed on (feeOwner, currency), so a balance can be sitting there from a
    // deploy that never shows up in any index we can query.
    const positions = await this.readPositions(ctx, tokens);

    let discovered: Address[] = [];
    if (this.options.deep) {
      const deep = await this.deepCurrencies(ctx);
      discovered = deep.currencies;

      if (!deep.discovery.complete) {
        notes.push({
          source: this.id,
          message:
            `Deep scan INCOMPLETE: ${deep.discovery.failedWindows} of ${deep.discovery.totalWindows} ` +
            `block windows could not be read` +
            (deep.discovery.failureSample ? ` (${deep.discovery.failureSample})` : "") +
            `. Currencies below that gap may be missing — this is not a full picture. ` +
            `Retry, ideally against an RPC with a higher rate limit.`,
        });
      }
      if (deep.resumedFrom !== null) {
        notes.push({
          source: this.id,
          message:
            `Deep scan resumed from cached block ${deep.resumedFrom}; history below it was ` +
            `covered by an earlier run. Use --no-cache to rescan from the FeeLocker's deployment.`,
        });
      }
    } else {
      notes.push({
        source: this.id,
        message:
          "Fast scan: Clanker currencies come from the baseline set plus this wallet's own deploys. " +
          "Fees also accrue in tokens the wallet never deployed, which this pass cannot see — " +
          "rerun with --deep for the complete set.",
      });
    }

    const currencies = [
      ...new Set(
        [
          ...CLANKER_BASELINE_CURRENCIES,
          ...paired,
          ...(this.options.tokens ?? []),
          ...positions.flatMap((p) => p.currencies),
          ...discovered,
        ].map((c) => getAddress(c).toLowerCase()),
      ),
    ].map((c) => getAddress(c));

    const { harvested, pending, pendingProbed } = await this.readBalances(ctx, currencies, positions);

    // currency -> the Clanker deploys whose pool it belongs to. Used for the
    // label and to know which token to sweep. May be empty for a currency we
    // found a balance in but could not trace to a specific deploy.
    const sources = new Map<string, Address[]>();
    for (const position of positions) {
      for (const currency of position.currencies) {
        const key = currency.toLowerCase();
        sources.set(key, [...(sources.get(key) ?? []), position.clankerToken]);
      }
    }

    const funded = currencies.filter(
      (c) => (harvested.get(c.toLowerCase()) ?? 0n) > 0n || (pending.get(c.toLowerCase()) ?? 0n) > 0n,
    );
    if (funded.length === 0) return { items: [], notes };

    const untraced = funded.filter((c) => (sources.get(c.toLowerCase()) ?? []).length === 0);
    if (untraced.length > 0) {
      notes.push({
        source: this.id,
        message:
          `${untraced.length} balance(s) were found in the FeeLocker that could not be traced to a ` +
          `specific deploy — the owner is a reward recipient on token(s) the clanker.world deployer ` +
          `index does not list. The amounts are real reads and fully claimable; only the originating ` +
          `token is unknown.`,
      });
    }

    if (this.options.includePending && !pendingProbed) {
      notes.push({
        source: this.id,
        message:
          "Pending (pool-side) fees could not be probed — this RPC does not support eth_simulateV1. " +
          "Amounts are harvested FeeLocker balances only and may under-report.",
      });
    } else if (!this.options.includePending) {
      notes.push({
        source: this.id,
        message:
          "Amounts are harvested FeeLocker balances. Fees still accruing in the pool are not " +
          "included — rerun with --include-pending to probe them.",
      });
    }

    const tokenInfo = await loadTokenInfo(this.client, funded, ctx.blockNumber);

    const items = funded.map((currency): UnclaimedItem => {
      const key = currency.toLowerCase();
      const harvestedAmount = harvested.get(key) ?? 0n;
      const pendingAmount = pending.get(key) ?? 0n;
      const info = tokenInfo.get(key);
      const fromTokens = sources.get(key) ?? [];

      const provenance = [
        contractRead({
          target: FEE_LOCKER,
          call: "availableFees(address feeOwner, address token)",
          args: [ctx.owner, currency],
          result: harvestedAmount,
          blockNumber: ctx.blockNumber,
        }),
      ];
      if (fromTokens.length > 0) {
        provenance.push(
          contractRead({
            target: LP_LOCKER,
            call: "tokenRewards(address token) [poolKey + rewardRecipients]",
            args: fromTokens,
            result: { owner: ctx.owner, currency, isRewardRecipient: true },
            blockNumber: ctx.blockNumber,
          }),
        );
      }
      if (pendingProbed) {
        provenance.push(
          staticCall({
            target: LP_LOCKER,
            call: "eth_simulateV1[collectRewards(token)... -> availableFees(feeOwner, currency)]",
            args: [fromTokens, ctx.owner, currency],
            result: { harvested: harvestedAmount, pendingAfterSweep: pendingAmount },
            blockNumber: ctx.blockNumber,
          }),
        );
      }
      if (apiUrl) {
        provenance.push(
          httpRead({
            url: apiUrl,
            call: `GET /tokens/fetch-deployed-by-address?address=${ctx.owner}`,
            result: { candidateTokens: fromTokens, note: "enumeration only, not an amount" },
          }),
        );
      }

      return {
        id: `clanker:${key}`,
        source: this.id,
        owner: ctx.owner,
        token: info ?? { address: currency, symbol: null, name: null, decimals: 18 },
        rawAmount: harvestedAmount + pendingAmount,
        usdValue: null,
        claimType: this.claimType,
        label:
          `Clanker creator fees in ${info?.symbol ?? currency}` +
          (fromTokens.length > 0
            ? ` (from ${fromTokens.length} deploy${fromTokens.length === 1 ? "" : "s"})`
            : " (originating deploy not identified)") +
          (pendingAmount > 0n ? " — includes pool fees, needs a sweep first" : ""),
        provenance,
        meta: {
          harvested: harvestedAmount.toString(),
          pending: pendingAmount.toString(),
          pendingProbed,
          requiresHarvest: pendingAmount > 0n,
          /** Tokens to `collectRewards` before claiming, when a sweep is needed. */
          sweepTokens: fromTokens,
        },
      };
    });

    return { items, notes };
  }

  async buildClaim(ctx: ScanContext, items: UnclaimedItem[]): Promise<ClaimTx[]> {
    const mine = items.filter((i) => i.source === this.id && i.rawAmount > 0n);
    const txs: ClaimTx[] = [];
    const swept = new Set<string>();

    for (const item of mine) {
      const meta = (item.meta ?? {}) as { requiresHarvest?: boolean; sweepTokens?: Address[] };
      const currency = getAddress(item.token.address);

      // Sweep only where pool-side fees were actually observed, and only once
      // per Clanker token even if both its currencies need it.
      if (meta.requiresHarvest) {
        for (const token of meta.sweepTokens ?? []) {
          if (swept.has(token.toLowerCase())) continue;
          swept.add(token.toLowerCase());
          txs.push({
            to: LP_LOCKER,
            data: encodeFunctionData({
              abi: clankerLpLockerAbi,
              functionName: "collectRewards",
              args: [getAddress(token)],
            }),
            value: 0n,
            chainId: ctx.chainId,
            claimType: this.claimType,
            description: `Sweep pool fees for Clanker token ${token} into the ClankerFeeLocker`,
            itemIds: [item.id],
            isPrerequisite: true,
          });
        }
      }

      // claim(feeOwner, token) reverts NoFeesToClaim on a zero balance — hence
      // the rawAmount > 0n filter above.
      txs.push({
        to: FEE_LOCKER,
        data: encodeFunctionData({
          abi: clankerFeeLockerAbi,
          functionName: "claim",
          args: [ctx.owner, currency],
        }),
        value: 0n,
        chainId: ctx.chainId,
        claimType: this.claimType,
        description: `Claim Clanker fees in ${item.token.symbol ?? currency} -> ${ctx.owner}`,
        itemIds: [item.id],
      });
    }

    return txs;
  }
}
