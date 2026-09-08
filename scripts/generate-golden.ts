import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PipelineSpec } from "../packages/contracts/src/index.js";
import { renderPipeline } from "../packages/generator/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifactRoot = join(repositoryRoot, "generated");
const artifactSubdirectory = "golden-erc4626";
const outputDirectory = join(artifactRoot, artifactSubdirectory);

const goldenSpec = {
  version: 1,
  displayName: "Base ERC-4626 Vault Flows",
  chain: { id: "base-mainnet" },
  standard: "erc4626",
  contracts: [
    {
      address: "0x050ce30b927da55177a4914ec73480238bad56f0",
      label: "Gauntlet USDC Prime v2",
    },
    {
      address: "0xbeeff2490feffa212fac2f6553682c219e6a8845",
      label: "Steakhouse High Yield USDC Edition",
    },
    {
      address: "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61",
      label: "Gauntlet USDC Prime",
    },
  ],
  startBlock: 50_999_146,
  events: ["Deposit", "Withdraw"],
  outputs: { rawEvents: true, hourlyFlows: true, topDepositors: true },
} satisfies PipelineSpec;

await rm(outputDirectory, { recursive: true, force: true });
const result = await renderPipeline({
  spec: goldenSpec,
  pipelineId: "pl_golden4626",
  pipelineVersion: 1,
  templateRoot: join(repositoryRoot, "templates", "erc4626"),
  artifactRoot,
  artifactSubdirectory,
});

process.stdout.write(`Generated ${result.outputDirectory}\n`);
