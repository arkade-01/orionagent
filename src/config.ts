import type { Address } from "viem";

export const BASE_CHAIN_ID = 8453;

/**
 * Verified Base mainnet addresses. Do not guess or edit these without reading
 * the verified source on a Base explorer first.
 */
export const ADDRESSES = {
  /** Clanker v4 core / factory. */
  clankerFactory: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
  /** ClankerFeeLocker v4.0.0 — holds harvested per-recipient fee balances. */
  clankerFeeLocker: "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68",
  /** ClankerLpLockerFeeConversion — sweeps pool fees into the FeeLocker. */
  clankerLpLocker: "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496",
  /** Merkl Distributor (ERC1967 proxy). */
  merklDistributor: "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae",
  /** Uniswap v3 NonfungiblePositionManager. */
  uniswapV3PositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
} as const satisfies Record<string, Address>;

export const API = {
  merkl: "https://api.merkl.xyz",
  clanker: "https://www.clanker.world/api",
  prices: "https://coins.llama.fi",
} as const;

/**
 * v1 monetization is a config constant only — there is no fee splitter contract
 * and nothing in the claim path touches this. It exists so the number lives in
 * one place when a splitter is built later.
 */
export const MONETIZATION = {
  feeBps: 0,
  feeRecipient: null as Address | null,
} as const;

/**
 * DefiLlama returns a confidence score with each price. Below this we treat the
 * token as unpriced (`usdValue: null`) rather than publish a number we do not
 * trust — thin/long-tail tokens are exactly the case this guards.
 */
export const MIN_PRICE_CONFIDENCE = 0.9;

/**
 * Currencies always probed for Clanker fees, whatever token enumeration turns up.
 *
 * The FeeLocker is keyed on `(feeOwner, currency)` — it has no idea which deploy
 * a balance came from. Letting token discovery decide whether to check a
 * currency at all is therefore wrong, and it under-reported a real wallet by
 * 16.5 WETH: the owner had deployed tokens they were not a recipient on, so
 * every token was filtered out and no currency was ever read, while their
 * balance sat there accrued from deploys the index never surfaced.
 *
 * Clanker v4 pairs overwhelmingly against WETH, with USDC second.
 */
export const CLANKER_BASELINE_CURRENCIES = [
  "0x4200000000000000000000000000000000000006", // WETH
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
] as const satisfies readonly Address[];

/** uint128 max — the "collect everything" sentinel for Uniswap v3 `collect`. */
export const UINT128_MAX = (1n << 128n) - 1n;

export interface RuntimeConfig {
  rpcUrl: string;
  chainId: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rpcUrl = env.BASE_RPC_URL?.trim();
  if (!rpcUrl) {
    throw new Error(
      "BASE_RPC_URL is not set. Copy .env.example to .env and point it at a Base RPC (chainId 8453).",
    );
  }
  return { rpcUrl, chainId: BASE_CHAIN_ID };
}
