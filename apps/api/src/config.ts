import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repositoryEnvPath = resolve(repositoryRoot, ".env");

loadDotenv({ path: repositoryEnvPath, quiet: true });

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
  HOST: z.string().min(1).default("127.0.0.1"),
  OPERATOR_API_TOKEN: z.string().min(32).max(256).optional().or(z.literal("")),
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
  LLM_PROVIDER: z.literal("google").default("google"),
  LLM_MODEL: z.string().min(1).default("gemini-3-flash-preview"),
  GEMINI_API_KEY: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PLANNER_PROMPT_VERSION: z.string().min(1).default("v1"),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV === "production" && !environment.OPERATOR_API_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["OPERATOR_API_TOKEN"],
      message: "A 32+ character operator token is required in production",
    });
  }
});

const parsed = EnvironmentSchema.parse(process.env);

export const apiConfig = {
  nodeEnv: parsed.NODE_ENV,
  port: parsed.PORT,
  host: parsed.HOST,
  operatorApiToken: parsed.OPERATOR_API_TOKEN || undefined,
  databaseUrl: parsed.DATABASE_URL,
  datasetDatabaseUrl: parsed.DATASET_DATABASE_URL,
  substreamsEndpoint: parsed.SUBSTREAMS_ENDPOINT,
  substreamsApiToken: parsed.SUBSTREAMS_API_TOKEN,
  substreamsCliPath: parsed.SUBSTREAMS_CLI_PATH,
  artifactRoot: resolve(repositoryRoot, parsed.ARTIFACT_ROOT),
  templateRoot: resolve(repositoryRoot, "templates/erc4626"),
  buildTimeoutMs: parsed.BUILD_TIMEOUT_SECONDS * 1_000,
  validationTimeoutMs: parsed.VALIDATION_TIMEOUT_SECONDS * 1_000,
  validationBlockCount: parsed.VALIDATION_BLOCK_COUNT,
  llmProvider: parsed.LLM_PROVIDER,
  llmModel: parsed.LLM_MODEL,
  geminiApiKey: parsed.GEMINI_API_KEY,
  llmTimeoutMs: parsed.LLM_TIMEOUT_MS,
  plannerPromptVersion: parsed.PLANNER_PROMPT_VERSION,
} as const;
