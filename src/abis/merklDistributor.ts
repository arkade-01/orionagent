/**
 * Merkl Distributor — proxy 0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae
 * (ERC1967 proxy; implementation `Distributor` at 0x64455A45d85D872Bfd7F833E367686108d13D6E6).
 *
 * ABI taken from the verified implementation source on Base.
 *
 * `claim` takes cumulative amounts plus merkle proofs, and credits `users[i]`
 * (unless that user set a claim recipient).
 *
 * IT IS NOT PERMISSIONLESS, despite crediting the user rather than the caller.
 * `_claim` reverts `NotWhitelisted()` unless one of these holds:
 *
 *     msg.sender == user
 *  || tx.origin  == user
 *  || mainOperators[msg.sender][token] != 0
 *  || mainOperators[msg.sender][address(0)] != 0
 *  || operators[user][msg.sender] != 0
 *  || operators[user][address(0)] != 0
 *  || accessControlManager.isGovernorOrGuardian(msg.sender)
 *
 * So a third-party agent can only submit the claim once the owner has approved
 * it via `toggleOperator(user, agent)`. Until then this source is `owner-sign`.
 *
 * A stale root, an already-fully-claimed entry, or an empty proof reverts the
 * WHOLE tx, so entries must be filtered before encoding.
 */
export const merklDistributorAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "users", type: "address[]" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "proofs", type: "bytes32[][]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint208" },
      { name: "timestamp", type: "uint48" },
      { name: "merkleRoot", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "operators",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "mainOperators",
    stateMutability: "view",
    inputs: [
      { name: "operator", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "toggleOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "claimRecipient",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "onlyOperatorCanClaim",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
