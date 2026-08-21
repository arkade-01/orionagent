import type { Provenance } from "./types.js";

function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? String(value);
}

export function contractRead(args: {
  target: string;
  call: string;
  args?: readonly unknown[];
  result: unknown;
  blockNumber?: bigint;
}): Provenance {
  return {
    kind: "contract-read",
    target: args.target,
    call: args.call,
    args: args.args?.map(stringify),
    result: stringify(args.result),
    blockNumber: args.blockNumber,
    fetchedAt: new Date().toISOString(),
  };
}

export function staticCall(args: {
  target: string;
  call: string;
  args?: readonly unknown[];
  result: unknown;
  blockNumber?: bigint;
}): Provenance {
  return { ...contractRead(args), kind: "contract-static-call" };
}

export function httpRead(args: {
  url: string;
  call: string;
  result: unknown;
}): Provenance {
  return {
    kind: "http-api",
    target: new URL(args.url).origin,
    call: args.call,
    result: stringify(args.result),
    fetchedAt: new Date().toISOString(),
  };
}
