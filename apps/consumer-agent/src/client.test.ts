import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { buildDatasetUrl, createRequirementPolicy } from "./client.js";

const config = {
  network: "hedera:testnet" as const,
  asset: "0.0.0" as const,
  maxAmount: "100000",
  expectedPayTo: "0.0.10442846",
};

const requirement: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.0",
  amount: "100000",
  payTo: "0.0.10442846",
  maxTimeoutSeconds: 300,
  extra: { feePayer: "0.0.1234" },
};

describe("consumer payment policy", () => {
  it("allows the approved Hedera testnet HBAR requirement", () => {
    expect(createRequirementPolicy(config)(2, [requirement])).toEqual([requirement]);
  });

  it.each([
    ["network", { network: "eip155:8453" }],
    ["scheme", { scheme: "upto" }],
    ["asset", { asset: "0.0.429274" }],
    ["recipient", { payTo: "0.0.9999" }],
    ["amount", { amount: "100001" }],
    ["fee payer", { extra: {} }],
  ])("rejects an unexpected %s", (_label, override) => {
    expect(() => createRequirementPolicy(config)(2, [
      { ...requirement, ...override } as PaymentRequirements,
    ]))
      .toThrow(/failed the network/);
  });

  it("rejects protocol v1", () => {
    expect(() => createRequirementPolicy(config)(1, [requirement])).toThrow(/v2/);
  });

  it("only constructs known Prompt2API dataset routes", () => {
    expect(buildDatasetUrl("http://localhost:4000", "base-vault-flows", "events"))
      .toBe("http://localhost:4000/v1/datasets/base-vault-flows/events?limit=25");
    expect(() => buildDatasetUrl("http://localhost:4000", "../admin", "events"))
      .toThrow(/slug/);
  });
});
