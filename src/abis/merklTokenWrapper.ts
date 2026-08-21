/**
 * Merkl "wrapped" reward token (e.g. "USD Coin (wrapped)" at
 * 0xa0d7a0D7F0A3CE1336B90Def568FA83b2DB157A8 on Base).
 *
 * Some Merkl campaigns distribute a wrapper instead of the reward token itself.
 * The wrapper burns itself the moment it lands and releases the real token 1:1,
 * so a claim of 682165 wrapper-USDC puts 682165 real USDC in the wallet and
 * leaves a zero wrapper balance behind.
 *
 * That matters for two reasons:
 *  - Pricing. Price feeds have never heard of the wrapper, so an unresolved
 *    wrapper is reported "unpriced" — real dollars shown as unknown value.
 *  - Honesty. The report should name the token the owner actually receives.
 *
 * `token()` is the underlying. `distributor()` pointing at the Merkl Distributor
 * is what distinguishes a genuine wrapper from any other contract that happens
 * to expose a `token()` view.
 */
export const merklTokenWrapperAbi = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "distributor", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
