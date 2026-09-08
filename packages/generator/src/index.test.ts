import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PipelineSpec } from "@indexloom/contracts";
import {
  FIXED_TEMPLATE_FILES,
  renderPipeline,
  type RenderedPipeline,
} from "./index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const templateRoot = join(repositoryRoot, "templates", "erc4626");
const temporaryRoots: string[] = [];

const spec = {
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
  ],
  startBlock: 50_999_146,
  events: ["Deposit", "Withdraw"],
  outputs: { rawEvents: true, hourlyFlows: true, topDepositors: true },
} satisfies PipelineSpec;

async function render(subdirectory: string): Promise<RenderedPipeline> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "indexloom-render-"));
  temporaryRoots.push(artifactRoot);
  return renderPipeline({
    spec,
    pipelineId: "pl_1234abcd",
    templateRoot,
    artifactRoot,
    artifactSubdirectory: subdirectory,
  });
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = join(prefix, entry.name).replaceAll("\\", "/");
      return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath];
    }),
  );
  return paths.flat().sort();
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("trusted ERC-4626 renderer", () => {
  it("copies only allowlisted fixed files and renders known outputs", async () => {
    const result = await render("first");
    const actualFiles = await listFiles(result.outputDirectory);
    expect(actualFiles).toEqual(
      [
        ...FIXED_TEMPLATE_FILES,
        "README.generated.md",
        "artifact-manifest.json",
        "pipeline-spec.json",
        "substreams.yaml",
      ].sort(),
    );

    for (const relativePath of FIXED_TEMPLATE_FILES) {
      const [templateBytes, generatedBytes] = await Promise.all([
        readFile(join(templateRoot, relativePath)),
        readFile(join(result.outputDirectory, relativePath)),
      ]);
      expect(generatedBytes.equals(templateBytes), relativePath).toBe(true);
    }
  });

  it("produces byte-identical output for the same input", async () => {
    const first = await render("first");
    const second = await render("second");
    const files = await listFiles(first.outputDirectory);
    for (const relativePath of files) {
      expect(
        (await readFile(join(second.outputDirectory, relativePath))).equals(
          await readFile(join(first.outputDirectory, relativePath)),
        ),
        relativePath,
      ).toBe(true);
    }
  });

  it("renders only backend-derived manifest values", async () => {
    const result = await render("safe");
    const manifest = await readFile(
      join(result.outputDirectory, "substreams.yaml"),
      "utf8",
    );
    expect(manifest).toContain("network: base");
    expect(manifest).toContain("ethereum-common/v0.3.3");
    expect(manifest).toContain("evt_addr:0x050ce30b927da55177a4914ec73480238bad56f0");
    expect(manifest).not.toContain("{{");
  });

  it("rejects path traversal and non-empty destinations", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "indexloom-render-"));
    temporaryRoots.push(artifactRoot);
    const common = {
      spec,
      pipelineId: "pl_1234abcd",
      templateRoot,
      artifactRoot,
    } as const;

    await expect(
      renderPipeline({ ...common, artifactSubdirectory: "../escape" }),
    ).rejects.toThrow(/Unsafe artifact/);
    await renderPipeline({ ...common, artifactSubdirectory: "existing" });
    await expect(
      renderPipeline({ ...common, artifactSubdirectory: "existing" }),
    ).rejects.toThrow(/not empty/);
  });
});
