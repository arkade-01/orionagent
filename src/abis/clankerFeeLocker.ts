/**
 * ClankerFeeLocker v4.0.0 — 0xF3622742b1E446D92e45E22923Ef11C2fcD55D68
 *
 * Taken from the verified source on Base (Blockscout `getabi`), not hand-written.
 *
 * Verified properties that this adapter depends on:
 *  - `claim(feeOwner, token)` takes the fee owner explicitly and does
 *    `SafeERC20.safeTransfer(IERC20(token), feeOwner, balance)` with no msg.sender
 *    check. It is therefore PERMISSIONLESS: any caller can claim, funds route to
 *    the owner. (Source comment: "claim fees on behalf of a feeOwner".)
 *  - `claim` reverts `NoFeesToClaim()` when the balance is 0, so zero-balance
 *    entries must be filtered out before building a tx.
 *  - `feesToClaim` / `availableFees` are HARVESTED balances only; `storeFees` is
 *    gated on `allowedDepositors` (the LP locker), so fees still sitting in the
 *    pool are not reflected here.
 */
export const clankerFeeLockerAbi = [
  {
    type: "function",
    name: "availableFees",
    stateMutability: "view",
    inputs: [
      { name: "feeOwner", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "feesToClaim",
    stateMutability: "view",
    inputs: [
      { name: "feeOwner", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "feeOwner", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "ClaimTokens",
    inputs: [
      { name: "feeOwner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amountClaimed", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "StoreTokens",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "feeOwner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "balance", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "NoFeesToClaim", inputs: [] },
] as const;
