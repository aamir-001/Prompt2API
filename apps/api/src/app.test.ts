import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PipelinePlanner, PipelineSpec } from "@indexloom/contracts";
import type { ProcessResult } from "@indexloom/substreams-runner";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { BuildWorker } from "./build-worker.js";
import { MemoryControlStore } from "./memory-store.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const temporaryRoots: string[] = [];

const goldenSpec: PipelineSpec = {
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
};

const validationOutput = `${JSON.stringify({
  "@module": "map_vault_events",
  "@block": 50_999_150,
  "@type": "indexloom.erc4626.v1.VaultEvents",
  "@data": {
    deposits: [
      {
        eventId: "base-mainnet:0xa88efc19760e12e3773270f004ede724b58d9a82d7cef2dd0d9adf811a275095:12",
        chainId: "base-mainnet",
        vaultAddress: "0x050ce30b927da55177a4914ec73480238bad56f0",
        senderAddress: "0x3af0490e309a701ef5ab55cd017b74f2e192e8c0",
        ownerAddress: "0x3af0490e309a701ef5ab55cd017b74f2e192e8c0",
        assetsRaw: "523694647",
        sharesRaw: "503316024132450944623",
        blockNumber: "50999150",
        blockTime: "2026-09-07T13:27:27Z",
        transactionHash: "0xa88efc19760e12e3773270f004ede724b58d9a82d7cef2dd0d9adf811a275095",
        logIndex: 12,
      },
    ],
  },
})}\n`;

function success(commandLabel: string, stdout = ""): ProcessResult {
  return {
    commandLabel,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
    cancelled: false,
    durationMs: 1,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("control API vertical slice", () => {
  it("takes a static plan through build and validation to approval", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "indexloom-api-"));
    temporaryRoots.push(artifactRoot);
    const store = new MemoryControlStore();
    const planner: PipelinePlanner = {
      async plan() {
        return { status: "ready", spec: goldenSpec };
      },
    };
    const runner = {
      async build(options: { projectDirectory: string }) {
        await writeFile(join(options.projectDirectory, "mock.spkg"), "package");
        return success("substreams build", "build ok");
      },
      async info() {
        return success("substreams info", "module info");
      },
      async graph() {
        return success("substreams graph", "digraph {}");
      },
      async validate() {
        return success("substreams run", validationOutput);
      },
    };
    const worker = new BuildWorker({
      store,
      runner,
      endpoint: "base-mainnet.streamingfast.io:443",
      apiToken: "test-token",
      buildTimeoutMs: 1_000,
      validationTimeoutMs: 1_000,
    });
    const app = createApp({
      store,
      planner,
      worker,
      artifactRoot,
      templateRoot: join(repositoryRoot, "templates", "erc4626"),
      validationBlockCount: 1_000,
      createPipelineId: () => "pl_test1234",
    });

    const plan = await request(app)
      .post("/v1/pipelines/plan")
      .send({ prompt: "Track my Base ERC-4626 vault" })
      .expect(200);
    expect(plan.body.status).toBe("PLAN_READY");
    expect(plan.body.derivedPlan.filterExpression).toContain("evt_addr:");

    await request(app)
      .post("/v1/pipelines/pl_test1234/build")
      .send({})
      .expect(202);

    let pipeline = await store.getPipeline("pl_test1234");
    for (let attempt = 0; pipeline?.state !== "AWAITING_APPROVAL" && attempt < 50; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      pipeline = await store.getPipeline("pl_test1234");
    }
    expect(pipeline?.state).toBe("AWAITING_APPROVAL");
    expect(pipeline?.runs.map(({ status }) => status)).toEqual([
      "SUCCEEDED",
      "SUCCEEDED",
      "SUCCEEDED",
      "SUCCEEDED",
    ]);

    const preview = await request(app)
      .get("/v1/pipelines/pl_test1234/preview")
      .expect(200);
    expect(preview.body.configurationHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preview.body.packageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preview.body.validation.eventCount).toBe(1);
    expect(preview.body.validation.preview[0].eventType).toBe("DEPOSIT");
  });

  it("returns 422 for unsupported scope", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "indexloom-api-"));
    temporaryRoots.push(artifactRoot);
    const store = new MemoryControlStore();
    const app = createApp({
      store,
      planner: {
        async plan() {
          return { status: "unsupported", reason: "NFTs are outside Phase 1" };
        },
      },
      worker: {
        async processNext() { return false; },
        cancel() { return false; },
      },
      artifactRoot,
      templateRoot: join(repositoryRoot, "templates", "erc4626"),
      validationBlockCount: 1_000,
      createPipelineId: () => "pl_test5678",
    });

    const response = await request(app)
      .post("/v1/pipelines/plan")
      .send({ prompt: "Track NFT sales" })
      .expect(422);
    expect(response.body.status).toBe("UNSUPPORTED_SCOPE");
  });
});
