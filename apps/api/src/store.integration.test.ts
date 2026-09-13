import { randomBytes } from "node:crypto";
import type { PipelineSpec } from "@prompt2api/contracts";
import { PrismaClient } from "@prompt2api/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaControlStore, type DerivedPlan } from "./store.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? (
  process.env.RUN_DATABASE_INTEGRATION === "1" ? process.env.DATABASE_URL : undefined
);
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const pipelineId = `pl_${randomBytes(5).toString("hex")}`;
const prisma =
  databaseUrl === undefined
    ? new PrismaClient()
    : new PrismaClient({ datasourceUrl: databaseUrl });

const spec: PipelineSpec = {
  version: 1,
  displayName: "PostgreSQL Queue Test",
  chain: { id: "base-mainnet" },
  standard: "erc4626",
  contracts: [{ address: "0x050ce30b927da55177a4914ec73480238bad56f0" }],
  startBlock: 50_999_146,
  events: ["Deposit"],
  outputs: { rawEvents: true, hourlyFlows: true, topDepositors: false },
};

const derivedPlan: DerivedPlan = {
  importedPackage: "ethereum-common@v0.3.3",
  modules: [
    "ethereum_common:filtered_events",
    "map_vault_events",
    "db_out",
  ],
  filterExpression: "(evt_addr:test) &&\n(evt_sig:test)",
  eventTopics: ["0xtest"],
  schemaName: `dataset_${pipelineId}`,
};

describeDatabase("PrismaControlStore", () => {
  const store = new PrismaControlStore(prisma);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (databaseUrl !== undefined) {
      await prisma.pipeline.deleteMany({ where: { id: pipelineId } });
    }
    await prisma.$disconnect();
  });

  it("claims the oldest PostgreSQL job and recovers interruption", async () => {
    await store.createPipeline(pipelineId, "integration test");
    await store.transition(pipelineId, "PLANNING", "test planning");
    await store.recordReadyPlan(
      pipelineId,
      spec,
      derivedPlan,
      `postgres-queue-test-${pipelineId.slice(3)}`,
    );
    await store.upsertApiProduct(pipelineId, {
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
    });
    const queued = await store.enqueueBuild({
      pipelineId,
      version: 1,
      artifactDirectory: "generated/integration-test",
      configurationHash: `sha256:${"0".repeat(64)}`,
      validationStartBlock: 50_999_146,
      validationStopBlock: 50_999_246,
    });
    const claimed = await store.claimOldestBuild();
    expect(claimed).toEqual(queued);
    await store.transition(pipelineId, "BUILDING", "claimed by test worker");
    expect(await store.recoverInterruptedJobs()).toBe(1);

    const pipeline = await store.getPipeline(pipelineId);
    expect(pipeline?.state).toBe("FAILED_INTERRUPTED");
    expect(pipeline?.runs[0]?.status).toBe("FAILED_INTERRUPTED");
    expect(pipeline?.pricing).toEqual(expect.objectContaining({
      protocol: "x402",
      amount: "100000",
      payTo: "0.0.10442846",
    }));
    expect(pipeline?.transitions.map(({ toState }) => toState)).toEqual([
      "DRAFT",
      "PLANNING",
      "PLAN_READY",
      "BUILD_QUEUED",
      "BUILDING",
      "FAILED_INTERRUPTED",
    ]);
  });
});
