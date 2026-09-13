import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PipelinePlanner, PipelineSpec } from "@prompt2api/contracts";
import type { ProcessResult } from "@prompt2api/substreams-runner";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { ApprovalService } from "./approval-service.js";
import { BuildWorker } from "./build-worker.js";
import { MemoryControlStore } from "./memory-store.js";
import { PlannerUnavailableError } from "@prompt2api/planner";

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
  "@type": "prompt2api.erc4626.v1.VaultEvents",
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
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-api-"));
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
    const approvalService = new ApprovalService(store, {
      async deploy(pipelineId, version, schemaName, startBlock) {
        const deployment = await store.createDeployment(
          pipelineId,
          version,
          schemaName,
          startBlock,
        );
        await store.markDeploymentLive(deployment.id, 1234);
        await store.transition(pipelineId, "LIVE", "Test sink started");
        return { ...deployment, status: "LIVE" as const, processId: 1234 };
      },
    });
    const datasetService = {
      async health() {
        return { indexedThroughBlock: "50999150" };
      },
      async events() {
        return {
          items: [{ eventId: "known-event", assetsRaw: "523694647" }],
          nextCursor: null,
        };
      },
      async hourlyFlows() {
        return { items: [], nextCursor: null };
      },
      async topDepositors() {
        return { items: [], nextCursor: null };
      },
    };
    const app = createApp({
      store,
      planner,
      worker,
      artifactRoot,
      templateRoot: join(repositoryRoot, "templates", "erc4626"),
      validationBlockCount: 1_000,
      approvalService,
      datasetService,
      allowLocalOperator: true,
      paymentGate: {
        ready: Promise.resolve(),
        metadata: {
          enabled: true,
          protocol: "x402",
          version: 2,
          network: "hedera:testnet",
          scheme: "exact",
          asset: "0.0.0",
          amount: "100000",
          unit: "tinybar",
          payTo: "0.0.10442846",
          protectedResources: ["events", "hourlyFlows"],
        },
        middleware(request, response, next) {
          if (request.header("x-test-paid") === "true") {
            next();
            return;
          }
          response.status(402).json({ error: { code: "PAYMENT_REQUIRED" } });
        },
      },
      createPipelineId: () => "pl_test1234",
    });

    const plan = await request(app)
      .post("/v1/pipelines/plan")
      .send({ prompt: "Track my Base ERC-4626 vault" })
      .expect(200);
    expect(plan.body.status).toBe("PLAN_READY");
    expect(plan.body.derivedPlan.filterExpression).toContain("evt_addr:");

    // An interrupted pre-queue render from an earlier request must not block a
    // fresh attempt of the same logical pipeline version.
    const staleDirectory = join(artifactRoot, "pl_test1234", "1");
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(join(staleDirectory, "partial-artifact"), "stale");

    await request(app)
      .post("/v1/pipelines/pl_test1234/build")
      .send({})
      .expect(202);

    const duplicateBuild = await request(app)
      .post("/v1/pipelines/pl_test1234/build")
      .send({})
      .expect(202);
    expect(duplicateBuild.body.pipelineId).toBe("pl_test1234");

    let pipeline = await store.getPipeline("pl_test1234");
    for (let attempt = 0; pipeline?.state !== "AWAITING_APPROVAL" && attempt < 50; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      pipeline = await store.getPipeline("pl_test1234");
    }
    expect(pipeline?.state).toBe("AWAITING_APPROVAL");
    expect(pipeline?.versions[0]?.artifactDirectory).toMatch(
      /[\\/]pl_test1234[\\/]1-[0-9a-f]{8}$/,
    );
    expect(pipeline?.runs.map(({ status }) => status)).toEqual([
      "SUCCEEDED",
      "SUCCEEDED",
      "SUCCEEDED",
      "SUCCEEDED",
    ]);

    const logs = await request(app)
      .get("/v1/pipelines/pl_test1234/logs")
      .expect(200);
    expect(logs.body.runs).toHaveLength(4);
    expect(logs.body.runs[0]).toMatchObject({
      stage: "BUILD",
      commandLabel: "substreams build/pack",
      status: "SUCCEEDED",
    });
    expect(logs.body.runs[0].durationMs).toEqual(expect.any(Number));

    const preview = await request(app)
      .get("/v1/pipelines/pl_test1234/preview")
      .expect(200);
    expect(preview.body.configurationHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preview.body.packageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preview.body.validation.eventCount).toBe(1);
    expect(preview.body.validation.preview[0].eventType).toBe("DEPOSIT");

    const changed = await request(app)
      .post("/v1/pipelines/pl_test1234/approve")
      .send({
        configurationHash: `sha256:${"f".repeat(64)}`,
        packageHash: preview.body.packageHash,
      })
      .expect(409);
    expect(changed.body.error.code).toBe("ARTIFACT_CHANGED");

    const approval = await request(app)
      .post("/v1/pipelines/pl_test1234/approve")
      .send({
        configurationHash: preview.body.configurationHash,
        packageHash: preview.body.packageHash,
      })
      .expect(202);
    expect(approval.body.status).toBe("LIVE");

    const livePipeline = await store.getPipeline("pl_test1234");
    const metadata = await request(app)
      .get(`/v1/datasets/${livePipeline!.slug}/meta`)
      .expect(200);
    expect(metadata.body.payment).toEqual(expect.objectContaining({
      protocol: "x402",
      amount: "100000",
    }));
    await request(app)
      .get(`/v1/datasets/${livePipeline!.slug}/events?limit=10`)
      .expect(402);
    const events = await request(app)
      .get(`/v1/datasets/${livePipeline!.slug}/events?limit=10`)
      .set("x-test-paid", "true")
      .expect(200);
    expect(events.body.status).toBe("LIVE");
    expect(events.body.items[0].eventId).toBe("known-event");
  });

  it("reports an empty successful sample distinctly and retries from a new block", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-api-"));
    temporaryRoots.push(artifactRoot);
    const store = new MemoryControlStore();
    let validationCalls = 0;
    const runner = {
      async build(options: { projectDirectory: string }) {
        await writeFile(join(options.projectDirectory, "mock.spkg"), "package");
        return success("substreams build");
      },
      async info() { return success("substreams info"); },
      async graph() { return success("substreams graph"); },
      async validate() {
        validationCalls += 1;
        return success(
          "substreams run",
          validationCalls === 1 ? "" : validationOutput,
        );
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
      planner: { async plan() { return { status: "ready", spec: goldenSpec }; } },
      worker,
      artifactRoot,
      templateRoot: join(repositoryRoot, "templates", "erc4626"),
      validationBlockCount: 100,
      approvalService: { async approve() { throw new Error("not used"); } },
      datasetService: {
        async health() { return { indexedThroughBlock: null }; },
        async events() { return { items: [], nextCursor: null }; },
        async hourlyFlows() { return { items: [], nextCursor: null }; },
        async topDepositors() { return { items: [], nextCursor: null }; },
      },
      allowLocalOperator: true,
      createPipelineId: () => "pl_noactivity",
    });

    await request(app)
      .post("/v1/pipelines/plan")
      .send({ prompt: "Track this Base vault" })
      .expect(200);
    await request(app)
      .post("/v1/pipelines/pl_noactivity/build")
      .send({})
      .expect(202);

    let pipeline = await store.getPipeline("pl_noactivity");
    for (let attempt = 0; pipeline?.state !== "VALIDATION_FAILED" && attempt < 50; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      pipeline = await store.getPipeline("pl_noactivity");
    }
    expect(pipeline?.state).toBe("VALIDATION_FAILED");
    expect(pipeline?.runs.at(-1)?.status).toBe("SUCCEEDED");

    const emptySample = await request(app)
      .get("/v1/pipelines/pl_noactivity")
      .expect(200);
    expect(emptySample.body.validationOutcome).toMatchObject({
      status: "NO_ACTIVITY_IN_SAMPLE",
      startBlock: goldenSpec.startBlock,
      stopBlock: goldenSpec.startBlock + 100,
    });
    expect(emptySample.body.validationOutcome.message).toContain(
      "no matching events occurred",
    );

    const newStartBlock = 50_999_200;
    await request(app)
      .post("/v1/pipelines/pl_noactivity/retry")
      .send({ startBlock: newStartBlock, command: "ignored" })
      .expect(400);
    await request(app)
      .post("/v1/pipelines/pl_noactivity/retry")
      .send({ startBlock: newStartBlock })
      .expect(202);

    for (let attempt = 0; pipeline?.state !== "AWAITING_APPROVAL" && attempt < 50; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      pipeline = await store.getPipeline("pl_noactivity");
    }
    expect(pipeline?.state).toBe("AWAITING_APPROVAL");
    expect(pipeline?.spec?.startBlock).toBe(newStartBlock);
    expect(pipeline?.versions.at(-1)).toMatchObject({
      validationStartBlock: newStartBlock,
      validationStopBlock: newStartBlock + 100,
    });
  });

  it("returns 422 for unsupported scope", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-api-"));
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
      approvalService: {
        async approve() {
          throw new Error("not used");
        },
      },
      datasetService: {
        async health() { return { indexedThroughBlock: null }; },
        async events() { return { items: [], nextCursor: null }; },
        async hourlyFlows() { return { items: [], nextCursor: null }; },
        async topDepositors() { return { items: [], nextCursor: null }; },
      },
      allowLocalOperator: true,
      createPipelineId: () => "pl_test5678",
    });

    const response = await request(app)
      .post("/v1/pipelines/plan")
      .send({ prompt: "Track NFT sales" })
      .expect(422);
    expect(response.body.status).toBe("UNSUPPORTED_SCOPE");
  });

  it("returns 503 PLANNER_UNAVAILABLE without inventing a default plan", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-api-"));
    temporaryRoots.push(artifactRoot);
    const store = new MemoryControlStore();
    const app = createApp({
      store,
      planner: {
        async plan() {
          throw new PlannerUnavailableError();
        },
      },
      worker: {
        async processNext() { return false; },
        cancel() { return false; },
      },
      artifactRoot,
      templateRoot: join(repositoryRoot, "templates", "erc4626"),
      validationBlockCount: 1_000,
      approvalService: {
        async approve() { throw new Error("not used"); },
      },
      datasetService: {
        async health() { return { indexedThroughBlock: null }; },
        async events() { return { items: [], nextCursor: null }; },
        async hourlyFlows() { return { items: [], nextCursor: null }; },
        async topDepositors() { return { items: [], nextCursor: null }; },
      },
      allowLocalOperator: true,
      createPipelineId: () => "pl_test9012",
    });

    const response = await request(app)
      .post("/v1/pipelines/plan")
      .send({ prompt: "Track a supported Base vault" })
      .expect(503);
    expect(response.body).toEqual({
      error: {
        code: "PLANNER_UNAVAILABLE",
        message: "The pipeline planner is temporarily unavailable",
      },
    });
    expect((await store.getPipeline("pl_test9012"))?.state).toBe("PLAN_FAILED");
  });

  it("does not expose pipeline creation anonymously", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-api-"));
    temporaryRoots.push(artifactRoot);
    const app = createApp({
      store: new MemoryControlStore(),
      planner: { async plan() { return { status: "unsupported", reason: "not used" }; } },
      worker: { async processNext() { return false; }, cancel() { return false; } },
      artifactRoot,
      templateRoot: join(repositoryRoot, "templates", "erc4626"),
      validationBlockCount: 1_000,
      approvalService: { async approve() { throw new Error("not used"); } },
      datasetService: {
        async health() { return { indexedThroughBlock: null }; },
        async events() { return { items: [], nextCursor: null }; },
        async hourlyFlows() { return { items: [], nextCursor: null }; },
        async topDepositors() { return { items: [], nextCursor: null }; },
      },
      operatorToken: "test-operator-token-with-at-least-32-characters",
    });

    await request(app)
      .post("/v1/pipelines/plan")
      .send({ prompt: "Track a vault" })
      .expect(401, { error: { code: "OPERATOR_AUTH_REQUIRED" } });
    await request(app)
      .post("/v1/pipelines/plan")
      .set("authorization", "Bearer test-operator-token-with-at-least-32-characters")
      .send({ prompt: "Track a vault" })
      .expect(422);
  });
});
