import { PrismaClient } from "@indexloom/db";
import type { PipelinePlanner } from "@indexloom/contracts";
import pino from "pino";
import { createApp } from "./app.js";
import { BuildWorker } from "./build-worker.js";
import { apiConfig } from "./config.js";
import { PrismaControlStore } from "./store.js";
import { SubstreamsRunner } from "@indexloom/substreams-runner";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const prisma = new PrismaClient({ datasourceUrl: apiConfig.databaseUrl });
const store = new PrismaControlStore(prisma);
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

const planner: PipelinePlanner = {
  async plan() {
    return {
      status: "unsupported",
      reason: "Gemini planning is added in Milestone 4",
    };
  },
};

await prisma.$connect();
await worker.start();
const app = createApp({
  store,
  planner,
  worker,
  artifactRoot: apiConfig.artifactRoot,
  templateRoot: apiConfig.templateRoot,
  validationBlockCount: apiConfig.validationBlockCount,
});
const server = app.listen(apiConfig.port, () => {
  logger.info({ port: apiConfig.port }, "IndexLoom API listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down IndexLoom API");
  worker.stop();
  server.close();
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
