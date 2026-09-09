import { PrismaClient } from "@indexloom/db";
import pino from "pino";
import { Pool } from "pg";
import { DatasetService } from "@indexloom/dataset-service";
import { createApp } from "./app.js";
import { ApprovalService } from "./approval-service.js";
import { BuildWorker } from "./build-worker.js";
import { apiConfig } from "./config.js";
import { PrismaControlStore } from "./store.js";
import { SubstreamsRunner } from "@indexloom/substreams-runner";
import { SinkManager } from "./sink-manager.js";
import { GeminiPipelinePlanner } from "@indexloom/planner";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const prisma = new PrismaClient({ datasourceUrl: apiConfig.databaseUrl });
const store = new PrismaControlStore(prisma);
const datasetPool = new Pool({ connectionString: apiConfig.datasetDatabaseUrl });
const datasetService = new DatasetService(datasetPool);
const runner = new SubstreamsRunner({
  artifactRoot: apiConfig.artifactRoot,
  executable: apiConfig.substreamsCliPath,
});
const worker = new BuildWorker({
  store,
  runner,
  endpoint: apiConfig.substreamsEndpoint,
  apiToken: apiConfig.substreamsApiToken,
  buildTimeoutMs: apiConfig.buildTimeoutMs,
  validationTimeoutMs: apiConfig.validationTimeoutMs,
});
const sinkManager = new SinkManager({
  store,
  datasetProvisioner: datasetService,
  artifactRoot: apiConfig.artifactRoot,
  executable: apiConfig.substreamsCliPath,
  endpoint: apiConfig.substreamsEndpoint,
  apiToken: apiConfig.substreamsApiToken,
  datasetDatabaseUrl: apiConfig.datasetDatabaseUrl,
  setupTimeoutMs: apiConfig.buildTimeoutMs,
});
const approvalService = new ApprovalService(store, sinkManager);

const planner = new GeminiPipelinePlanner({
  apiKey: apiConfig.geminiApiKey,
  model: apiConfig.llmModel,
  timeoutMs: apiConfig.llmTimeoutMs,
  promptVersion: apiConfig.plannerPromptVersion,
  // Structured override annotations add a small trusted suffix to the 4,000-character user prompt.
  maxPromptLength: 5_000,
  recordMetric(metric) {
    logger.info(metric, "Pipeline planner request completed");
  },
});

await prisma.$connect();
await datasetPool.query("SELECT 1");
await sinkManager.restartLiveDeployments();
await worker.start();
const app = createApp({
  store,
  planner,
  worker,
  artifactRoot: apiConfig.artifactRoot,
  templateRoot: apiConfig.templateRoot,
  validationBlockCount: apiConfig.validationBlockCount,
  approvalService,
  datasetService,
  operatorToken: apiConfig.operatorApiToken,
  allowLocalOperator: apiConfig.nodeEnv !== "production",
});
const server = app.listen(apiConfig.port, apiConfig.host, () => {
  logger.info({ host: apiConfig.host, port: apiConfig.port }, "IndexLoom API listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down IndexLoom API");
  worker.stop();
  await sinkManager.stopAll();
  server.close();
  await datasetPool.end();
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
