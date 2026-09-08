import { describe, expect, it } from "vitest";
import {
  derivePipelineConfig,
  ERC4626_EVENT_TOPICS,
} from "./index.js";

const mixedCaseAddress = "0x050CE30b927Da55177A4914Ec73480238bAd56F0";

const spec = {
  version: 1,
  displayName: "Base ERC-4626 Vault Flows",
  chain: { id: "base-mainnet" },
  standard: "erc4626",
  contracts: [{ address: mixedCaseAddress, label: "Vault A" }],
  startBlock: 50_999_146,
  events: ["Deposit", "Withdraw"],
  outputs: { rawEvents: true, hourlyFlows: true, topDepositors: true },
};

describe("derivePipelineConfig", () => {
  it("derives canonical ERC-4626 topics through viem", () => {
    expect(ERC4626_EVENT_TOPICS).toEqual({
      Deposit:
        "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7",
      Withdraw:
        "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db",
    });
  });

  it("normalizes addresses and creates an explicitly grouped filter", () => {
    const result = derivePipelineConfig(spec, { pipelineId: "pl_1234abcd" });

    expect(result.normalizedSpec.contracts[0]?.address).toBe(
      mixedCaseAddress.toLowerCase(),
    );
    expect(result.filter).toBe(
      `(evt_addr:${mixedCaseAddress.toLowerCase()}) &&\n` +
        `(evt_sig:${ERC4626_EVENT_TOPICS.Deposit} || evt_sig:${ERC4626_EVENT_TOPICS.Withdraw})`,
    );
    expect(result.packageName).toBe("base_erc_4626_vault_flows_1234abcd");
    expect(result.schemaName).toBe("dataset_pl_1234abcd");
  });

  it("is deterministic", () => {
    const first = derivePipelineConfig(spec, { pipelineId: "pl_1234abcd" });
    const second = derivePipelineConfig(spec, { pipelineId: "pl_1234abcd" });
    expect(second).toEqual(first);
  });
});
