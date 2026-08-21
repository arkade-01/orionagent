/**
 * ClankerLpLockerFeeConversion (v4 LP locker) — 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496
 *
 * From the verified source on Base. Two things we use:
 *  - `collectRewards(token)`: sweeps pool-accrued ("pending") fees into the
 *    ClankerFeeLocker for every reward recipient of that token. Takes no
 *    recipient argument and is not owner-gated, so it can be used as a harvest
 *    step before a FeeLocker claim.
 *  - `tokenRewards(token)`: the on-chain reward-recipient split, used to confirm
 *    an owner really is a recipient (rather than trusting the REST API alone).
 */
export const clankerLpLockerAbi = [
  {
    type: "function",
    name: "collectRewards",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "collectRewardsWithoutUnlock",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "feeLocker",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokenRewards",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "positionId", type: "uint256" },
          { name: "numPositions", type: "uint256" },
          { name: "rewardBps", type: "uint16[]" },
          { name: "rewardAdmins", type: "address[]" },
          { name: "rewardRecipients", type: "address[]" },
        ],
      },
    ],
  },
] as const;
