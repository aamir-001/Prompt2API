import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repositoryEnvPath = resolve(repositoryRoot, ".env");

loadDotenv({ path: repositoryEnvPath, quiet: true });

const HederaEntityIdSchema = z.string().regex(/^0\.0\.[1-9]\d*$/);

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
  BUILD_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  VALIDATION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  VALIDATION_BLOCK_COUNT: z.coerce.number().int().positive().max(100_000).default(100),
  MAX_ACTIVE_PIPELINE_JOBS: z.literal("1").default("1"),
  LLM_PROVIDER: z.literal("google").default("google"),
  LLM_MODEL: z.string().min(1).default("gemini-3-flash-preview"),
  GEMINI_API_KEY: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PLANNER_PROMPT_VERSION: z.string().min(1).default("v1"),
  X402_ENABLED: z.enum(["true", "false"]).default("false"),
  X402_NETWORK: z.literal("hedera:testnet").default("hedera:testnet"),
  X402_SCHEME: z.literal("exact").default("exact"),
  X402_ASSET: z.literal("0.0.0").default("0.0.0"),
  X402_PRICE: z.string().regex(/^[1-9]\d*$/).default("100000"),
  X402_PAY_TO: HederaEntityIdSchema.optional().or(z.literal("")),
  X402_FACILITATOR_URL: z.string().url().default("https://api.testnet.blocky402.com"),
  X402_MAX_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(3_600).default(300),
  X402_FACILITATOR_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(30_000),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV === "production" && !environment.OPERATOR_API_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["OPERATOR_API_TOKEN"],
      message: "A 32+ character operator token is required in production",
    });
  }
  if (environment.X402_ENABLED === "true" && !environment.X402_PAY_TO) {
    context.addIssue({
      code: "custom",
      path: ["X402_PAY_TO"],
      message: "A Hedera recipient account is required when x402 is enabled",
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
  payment: {
    enabled: parsed.X402_ENABLED === "true",
    network: parsed.X402_NETWORK,
    scheme: parsed.X402_SCHEME,
    asset: parsed.X402_ASSET,
    amount: parsed.X402_PRICE,
    payTo: parsed.X402_PAY_TO || "",
    facilitatorUrl: parsed.X402_FACILITATOR_URL,
    maxTimeoutSeconds: parsed.X402_MAX_TIMEOUT_SECONDS,
    facilitatorTimeoutMs: parsed.X402_FACILITATOR_TIMEOUT_MS,
  },
} as const;
