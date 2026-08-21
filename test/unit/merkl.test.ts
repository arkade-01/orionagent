import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { merklDistributorAbi } from "../../src/abis/merklDistributor.js";
import { MerklAdapter, fetchMerklClaimables } from "../../src/adapters/merkl.js";
import { ADDRESSES } from "../../src/config.js";
import type { ScanContext } from "../../src/types.js";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const TOKEN_A = "0xaAaAaAaaAaAaAaaAaA000000000000000000000A" as const;
const TOKEN_B = "0xBbBbBBBbbBBBbbbBbbBb000000000000000000bB" as const;
const AGENT = "0x2222222222222222222222222222222222222222" as const;

const ctx: ScanContext = { owner: OWNER, chainId: 8453, blockNumber: 1n };

function reward(over: Record<string, unknown> = {}) {
  return {
    root: `0x${"22".repeat(32)}`,
    recipient: OWNER,
    amount: "1000",
    claimed: "400",
    proofs: [`0x${"11".repeat(32)}`],
    token: { chainId: 8453, address: TOKEN_A, symbol: "AAA", decimals: 18 },
    ...over,
  };
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * Stands in for the Distributor. Defaults are the common case: nothing claimed
 * on-chain yet, no payout redirect, agent not approved as an operator.
 */
function stubClient(
  opts: {
    /** token (lowercase) -> claimed[user][token].amount */
    claimed?: Record<string, bigint>;
    /** token (lowercase) -> claimRecipient[user][token]; "*" for the global one */
    redirect?: Record<string, string>;
    operatorApproved?: boolean;
    /** wrapper (lowercase) -> { underlying, decimals }; marks it a Merkl wrapper. */
    wrappers?: Record<string, { underlying: string; decimals: number }>;
  } = {},
) {
  const claimedFor = (token: string) => opts.claimed?.[token.toLowerCase()] ?? 0n;
  const redirectFor = (token: string) => opts.redirect?.[token.toLowerCase()] ?? ZERO;

  const wrapperFor = (address: string) => opts.wrappers?.[address.toLowerCase()];

  const call = (functionName: string, args: readonly unknown[], address?: string) => {
    switch (functionName) {
      // Merkl wrapper probe. A plain reward token exposes none of these.
      case "token": {
        const w = wrapperFor(address ?? "");
        if (!w) throw new Error("not a wrapper");
        return w.underlying;
      }
      case "distributor": {
        if (!wrapperFor(address ?? "")) throw new Error("not a wrapper");
        return ADDRESSES.merklDistributor;
      }
      case "decimals": {
        const w = wrapperFor(address ?? "");
        if (w) return w.decimals;
        const underlying = Object.values(opts.wrappers ?? {}).find(
          (x) => x.underlying.toLowerCase() === (address ?? "").toLowerCase(),
        );
        if (underlying) return underlying.decimals;
        throw new Error("no decimals");
      }
      case "symbol":
      case "name":
        throw new Error("no metadata");
      case "claimed":
        return [claimedFor(args[1] as string), 0, `0x${"00".repeat(32)}`];
      case "claimRecipient":
        return (args[1] as string) === ZERO ? (opts.redirect?.["*"] ?? ZERO) : redirectFor(args[1] as string);
      case "operators":
        return opts.operatorApproved ? 1n : 0n;
      case "mainOperators":
        return 0n;
      default:
        throw new Error(`unstubbed ${functionName}`);
    }
  };

  const attempt = (c: { functionName: string; args?: readonly unknown[]; address?: string }) => {
    try {
      return { status: "success", result: call(c.functionName, c.args ?? [], c.address) };
    } catch (err) {
      return { status: "failure", error: err };
    }
  };

  return {
    multicall: async ({
      contracts,
    }: {
      contracts: { functionName: string; args?: readonly unknown[]; address?: string }[];
    }) => contracts.map(attempt),
    readContract: async ({
      functionName,
      args,
      address,
    }: {
      functionName: string;
      args?: readonly unknown[];
      address?: string;
    }) => call(functionName, args ?? [], address),
  } as never;
}

function stub(rewards: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => [{ chain: { id: 8453 }, rewards }],
  })) as unknown as typeof fetch & { mock: { calls: unknown[] } };
}

describe("merkl adapter", () => {
  it("reports amount - claimed, not the cumulative amount", async () => {
    // API says claimed 400; the chain agrees. 1000 - 400 = 600.
    const { items } = await new MerklAdapter(stubClient({ claimed: { [TOKEN_A.toLowerCase()]: 400n } }), stub([reward()])).scan(ctx);
    expect(items).toHaveLength(1);
    expect(items[0]!.rawAmount).toBe(600n);
    expect(items[0]!.meta?.cumulativeAmount).toBe("1000");
  });

  it("skips fully-claimed entries — they revert the whole tx", async () => {
    const { claimables } = await fetchMerklClaimables(
      OWNER,
      stub([reward({ amount: "500", claimed: "500" })]),
    );
    expect(claimables).toHaveLength(0);
  });

  it("skips entries with empty proofs — InvalidProof takes the batch down", async () => {
    const { claimables } = await fetchMerklClaimables(OWNER, stub([reward({ proofs: [] })]));
    expect(claimables).toHaveLength(0);
  });

  it("ignores rewards from other chains", async () => {
    const other = vi.fn(async () => ({
      ok: true,
      json: async () => [{ chain: { id: 1 }, rewards: [reward()] }],
    })) as unknown as typeof fetch;
    const { claimables } = await fetchMerklClaimables(OWNER, other);
    expect(claimables).toHaveLength(0);
  });

  it("refetches proofs at claim time instead of reusing the scan's", async () => {
    const fetchImpl = stub([reward()]);
    const adapter = new MerklAdapter(stubClient(), fetchImpl);
    const { items } = await adapter.scan(ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await adapter.buildClaim(ctx, items);
    // A second call means the proofs in the tx came from a fresh fetch, which is
    // what keeps a ~4h-old proof from being encoded into a claim.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("encodes cumulative amounts and credits the owner", async () => {
    const adapter = new MerklAdapter(
      stubClient(),
      stub([reward(), reward({ token: { chainId: 8453, address: TOKEN_B, symbol: "BBB", decimals: 6 }, amount: "7", claimed: "0" })]),
    );
    const { items } = await adapter.scan(ctx);
    const [tx] = await adapter.buildClaim(ctx, items);

    expect(tx!.to).toBe(ADDRESSES.merklDistributor);
    const { args } = decodeFunctionData({ abi: merklDistributorAbi, data: tx!.data });
    const [users, tokens, amounts, proofs] = args as [string[], string[], bigint[], string[][]];
    expect(users).toEqual([OWNER, OWNER]);
    expect(tokens).toHaveLength(2);
    expect(amounts).toEqual([1000n, 7n]); // cumulative, not the 600n delta
    expect(proofs.every((p) => p.length > 0)).toBe(true);
  });

  it("defaults to owner-sign — the Distributor rejects unapproved callers", async () => {
    const { items } = await new MerklAdapter(stubClient(), stub([reward()])).scan(ctx);
    expect(items[0]!.claimType).toBe("owner-sign");
  });

  it("notes why Merkl needs a signature when the agent is not an operator", async () => {
    const { notes } = await new MerklAdapter(stubClient(), stub([reward()])).scan(ctx);
    expect(notes?.[0]?.message).toContain("toggleOperator");
  });

  it("upgrades to permissionless once the owner has approved the agent", async () => {
    const adapter = new MerklAdapter(stubClient({ operatorApproved: true }), stub([reward()]), AGENT);
    const { items, notes } = await adapter.scan(ctx);
    expect(items[0]!.claimType).toBe("permissionless");
    expect(notes).toEqual([]);

    const [tx] = await adapter.buildClaim(ctx, items);
    expect(tx!.claimType).toBe("permissionless");
  });

  it("stays owner-sign when the operator check reverts", async () => {
    type Multicall = (a: { contracts: { functionName: string }[] }) => Promise<unknown>;
    const base = stubClient() as unknown as { multicall: Multicall; readContract: unknown };
    const client = {
      readContract: base.readContract,
      // Fail only the operator lookup; everything else reads normally.
      multicall: async (a: { contracts: { functionName: string }[] }) => {
        if (a.contracts.some((c) => c.functionName === "operators")) throw new Error("rpc down");
        return base.multicall(a);
      },
    };
    const { items } = await new MerklAdapter(client as never, stub([reward()]), AGENT).scan(ctx);
    expect(items).toHaveLength(1);
    expect(items[0]!.claimType).toBe("owner-sign");
  });

  it("trusts the contract's claimed over the API's when they disagree", async () => {
    // The API still advertises 600 outstanding; the chain says it was all paid.
    const drained = stubClient({ claimed: { [TOKEN_A.toLowerCase()]: 1000n } });
    const { items } = await new MerklAdapter(drained, stub([reward()])).scan(ctx);
    expect(items).toEqual([]);

    // Partially claimed on-chain beyond what the API knows about.
    const partial = stubClient({ claimed: { [TOKEN_A.toLowerCase()]: 900n } });
    const { items: some } = await new MerklAdapter(partial, stub([reward()])).scan(ctx);
    expect(some[0]!.rawAmount).toBe(100n); // not the API's 600n
  });

  it("says so when the payout is redirected away from the wallet", async () => {
    const elsewhere = "0x3333333333333333333333333333333333333333";
    const client = stubClient({ redirect: { [TOKEN_A.toLowerCase()]: elsewhere } });
    const { items, notes } = await new MerklAdapter(client, stub([reward()])).scan(ctx);
    expect(items[0]!.label).toContain("pays out to");
    expect(items[0]!.meta?.recipient).toBe(elsewhere);
    expect(notes?.some((n) => n.message.includes("claimRecipient"))).toBe(true);
  });

  it("honours a global claimRecipient set for every token", async () => {
    const elsewhere = "0x4444444444444444444444444444444444444444";
    const { items } = await new MerklAdapter(stubClient({ redirect: { "*": elsewhere } }), stub([reward()])).scan(ctx);
    expect(items[0]!.meta?.recipient).toBe(elsewhere);
  });

  it("reports the token the wallet actually receives for a wrapped campaign", async () => {
    // Merkl distributes a wrapper that burns itself on receipt and releases the
    // real token 1:1. Naming the wrapper would leave real value shown unpriced.
    const UNDERLYING = "0x5555555555555555555555555555555555555555";
    const client = stubClient({
      wrappers: { [TOKEN_A.toLowerCase()]: { underlying: UNDERLYING, decimals: 18 } },
    });
    const adapter = new MerklAdapter(client, stub([reward()]));
    const { items } = await adapter.scan(ctx);

    expect(items[0]!.token.address.toLowerCase()).toBe(UNDERLYING);
    expect(items[0]!.label).toContain("unwrapped 1:1");
    expect(items[0]!.meta?.rewardToken).toBe(getAddress(TOKEN_A));

    // The tx still has to name the wrapper — that is what the proof commits to.
    const [tx] = await adapter.buildClaim(ctx, items);
    const { args } = decodeFunctionData({ abi: merklDistributorAbi, data: tx!.data });
    expect((args as unknown as [string[], string[]])[1]![0]).toBe(getAddress(TOKEN_A));
  });

  it("leaves a plain reward token alone", async () => {
    const { items } = await new MerklAdapter(stubClient(), stub([reward()])).scan(ctx);
    expect(items[0]!.token.address).toBe(getAddress(TOKEN_A));
    expect(items[0]!.label).not.toContain("unwrapped");
  });

  it("builds nothing when no item survives filtering", async () => {
    const adapter = new MerklAdapter(stubClient(), stub([reward({ proofs: [] })]));
    const { items } = await adapter.scan(ctx);
    expect(await adapter.buildClaim(ctx, items)).toEqual([]);
  });
});
