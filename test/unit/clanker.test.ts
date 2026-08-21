import { describe, expect, it } from "vitest";
import { ClankerAdapter } from "../../src/adapters/clanker.js";
import { ADDRESSES, CLANKER_BASELINE_CURRENCIES } from "../../src/config.js";
import { clearTokenCache } from "../../src/tokens.js";
import type { ScanContext } from "../../src/types.js";

const OWNER = "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504" as const;
const WETH = CLANKER_BASELINE_CURRENCIES[0];
const SOMEONE_ELSE = "0xeaCDB295CD1543Dd642daea1dCd23DC5fEa13d53" as const;
const DEPLOYED = "0x4e6d702fb722514cC44B9e32B3Adbd37aB41EB07" as const;

const ctx: ScanContext = { owner: OWNER, chainId: 8453, blockNumber: 1n };

/** The clanker.world deployer index: tokens this wallet launched. */
function stubApi(tokens: { contract_address: string; recipients: string[] }[]) {
  return (async () => ({
    ok: true,
    json: async () => ({
      data: tokens.map((t) => ({
        contract_address: t.contract_address,
        symbol: "TKN",
        type: "clanker_v4",
        chain_id: 8453,
        pool_config: { pairedToken: WETH },
        extensions: {
          fees: { recipients: t.recipients.map((r) => ({ bps: 10000, admin: r, recipient: r })) },
        },
      })),
    }),
  })) as unknown as typeof fetch;
}

/** FeeLocker + LP locker. `balances` is keyed on currency, as the contract is. */
function stubClient(balances: Record<string, bigint>, recipientsByToken: Record<string, string[]> = {}) {
  const answer = (address: string, functionName: string, args: readonly unknown[]) => {
    if (address.toLowerCase() === ADDRESSES.clankerFeeLocker.toLowerCase()) {
      return balances[String(args[1]).toLowerCase()] ?? 0n;
    }
    if (address.toLowerCase() === ADDRESSES.clankerLpLocker.toLowerCase()) {
      const token = String(args[0]);
      const recipients = recipientsByToken[token.toLowerCase()] ?? [];
      return {
        token,
        poolKey: { currency0: WETH, currency1: token, fee: 0, tickSpacing: 0, hooks: WETH },
        positionId: 0n,
        numPositions: 1n,
        rewardBps: [10000],
        rewardAdmins: recipients,
        rewardRecipients: recipients,
      };
    }
    if (functionName === "symbol") return "WETH";
    if (functionName === "name") return "Wrapped Ether";
    if (functionName === "decimals") return 18;
    throw new Error(`unstubbed ${functionName}`);
  };

  return {
    multicall: async ({
      contracts,
    }: {
      contracts: { address: string; functionName: string; args?: readonly unknown[] }[];
    }) =>
      contracts.map((c) => {
        try {
          return { status: "success", result: answer(c.address, c.functionName, c.args ?? []) };
        } catch (err) {
          return { status: "failure", error: err };
        }
      }),
  } as never;
}

describe("clanker adapter", () => {
  it("finds a balance even when the owner is a recipient on none of their deploys", async () => {
    // The bug this guards: this wallet deployed five tokens whose fees route to
    // other people, so every token was filtered out and no currency was ever
    // read — while 16.5 WETH sat in the FeeLocker, earned on deploys the
    // deployer index does not list. The scan reported "nothing found".
    clearTokenCache();
    const client = stubClient(
      { [WETH.toLowerCase()]: 16_545_614_492_853_498_710n },
      { [DEPLOYED.toLowerCase()]: [SOMEONE_ELSE] }, // owner is NOT a recipient
    );
    const adapter = new ClankerAdapter(client, {
      fetchImpl: stubApi([{ contract_address: DEPLOYED, recipients: [SOMEONE_ELSE] }]),
    });

    const { items, notes } = await adapter.scan(ctx);
    expect(items).toHaveLength(1);
    expect(items[0]!.rawAmount).toBe(16_545_614_492_853_498_710n);
    expect(items[0]!.token.address.toLowerCase()).toBe(WETH.toLowerCase());
    expect(items[0]!.label).toContain("originating deploy not identified");
    expect(notes?.some((n) => n.message.includes("could not be traced"))).toBe(true);
  });

  it("still reports nothing when the balances really are zero", async () => {
    clearTokenCache();
    const adapter = new ClankerAdapter(stubClient({}), {
      fetchImpl: stubApi([{ contract_address: DEPLOYED, recipients: [SOMEONE_ELSE] }]),
    });
    expect((await adapter.scan(ctx)).items).toEqual([]);
  });

  it("probes the baseline currencies even with no deploys at all", async () => {
    clearTokenCache();
    const adapter = new ClankerAdapter(stubClient({ [WETH.toLowerCase()]: 5n }), {
      fetchImpl: stubApi([]),
    });
    const { items } = await adapter.scan(ctx);
    expect(items).toHaveLength(1);
    expect(items[0]!.rawAmount).toBe(5n);
  });

  it("names the deploys when the owner IS a recipient", async () => {
    clearTokenCache();
    const client = stubClient({ [WETH.toLowerCase()]: 100n }, { [DEPLOYED.toLowerCase()]: [OWNER] });
    const adapter = new ClankerAdapter(client, {
      fetchImpl: stubApi([{ contract_address: DEPLOYED, recipients: [OWNER] }]),
    });
    const { items } = await adapter.scan(ctx);
    expect(items[0]!.label).toContain("from 1 deploy");
  });

  it("claims per currency, and skips zero balances the locker would revert on", async () => {
    clearTokenCache();
    const client = stubClient({ [WETH.toLowerCase()]: 100n }, { [DEPLOYED.toLowerCase()]: [OWNER] });
    const adapter = new ClankerAdapter(client, {
      fetchImpl: stubApi([{ contract_address: DEPLOYED, recipients: [OWNER] }]),
    });
    const { items } = await adapter.scan(ctx);
    const txs = await adapter.buildClaim(ctx, items);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.to).toBe(ADDRESSES.clankerFeeLocker);
    expect(txs[0]!.claimType).toBe("permissionless");

    const zeroed = items.map((i) => ({ ...i, rawAmount: 0n }));
    expect(await adapter.buildClaim(ctx, zeroed)).toEqual([]);
  });
});
