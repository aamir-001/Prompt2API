import { describe, expect, it } from "vitest";
import { parsePipelineSpec } from "./index.js";

const validSpec = {
  version: 1,
  displayName: "Base ERC-4626 Vault Flows",
  chain: { id: "base-mainnet" },
  standard: "erc4626",
  contracts: [
    {
      address: "0x050ce30b927da55177a4914ec73480238bad56f0",
      label: "Gauntlet USDC Prime v2",
    },
  ],
  startBlock: 50_999_146,
  events: ["Deposit", "Withdraw"],
  outputs: { rawEvents: true, hourlyFlows: true, topDepositors: true },
} as const;

describe("PipelineSpec", () => {
  it("accepts the golden Phase 1 specification", () => {
    expect(parsePipelineSpec(validSpec)).toEqual(validSpec);
  });

  it("rejects unexpected fields", () => {
    expect(() => parsePipelineSpec({ ...validSpec, command: "cargo add" })).toThrow();
  });

  it("rejects malformed and duplicate addresses", () => {
    expect(() =>
      parsePipelineSpec({
        ...validSpec,
        contracts: [{ address: "0xnot-an-address" }],
      }),
    ).toThrow();

    expect(() =>
      parsePipelineSpec({
        ...validSpec,
        contracts: [validSpec.contracts[0], validSpec.contracts[0]],
      }),
    ).toThrow(/unique/);
  });

  it("rejects duplicate events and untrimmed labels", () => {
    expect(() =>
      parsePipelineSpec({ ...validSpec, events: ["Deposit", "Deposit"] }),
    ).toThrow(/unique/);
    expect(() =>
      parsePipelineSpec({
        ...validSpec,
        contracts: [{ ...validSpec.contracts[0], label: " padded " }],
      }),
    ).toThrow(/trimmed/);
  });
});
