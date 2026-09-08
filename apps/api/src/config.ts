import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ quiet: true });

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
  DATABASE_URL: z.string().min(1),
  DATASET_DATABASE_URL: z.string().min(1),
  SUBSTREAMS_ENDPOINT: z.string().regex(/^[a-z0-9.-]+:\d+$/i),
  SUBSTREAMS_API_TOKEN: z.string().min(1),
  SUBSTREAMS_CLI_PATH: z.string().min(1).default("substreams"),
  ARTIFACT_ROOT: z.string().min(1).default("./generated"),
  BUILD_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  VALIDATION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  VALIDATION_BLOCK_COUNT: z.coerce.number().int().positive().max(100_000).default(1_000),
  MAX_ACTIVE_PIPELINE_JOBS: z.literal("1").default("1"),
});

const parsed = EnvironmentSchema.parse(process.env);

export const apiConfig = {
  nodeEnv: parsed.NODE_ENV,
  port: parsed.PORT,
  databaseUrl: parsed.DATABASE_URL,
  datasetDatabaseUrl: parsed.DATASET_DATABASE_URL,
  substreamsEndpoint: parsed.SUBSTREAMS_ENDPOINT,
  substreamsApiToken: parsed.SUBSTREAMS_API_TOKEN,
  substreamsCliPath: parsed.SUBSTREAMS_CLI_PATH,
  artifactRoot: resolve(parsed.ARTIFACT_ROOT),
  templateRoot: resolve("templates/erc4626"),
  buildTimeoutMs: parsed.BUILD_TIMEOUT_SECONDS * 1_000,
  validationTimeoutMs: parsed.VALIDATION_TIMEOUT_SECONDS * 1_000,
  validationBlockCount: parsed.VALIDATION_BLOCK_COUNT,
} as const;
