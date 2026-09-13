import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });

const HederaEntityIdSchema = z.string().regex(/^0\.0\.[1-9]\d*$/);

const EnvironmentSchema = z.object({
  HEDERA_PAYER_ACCOUNT_ID: HederaEntityIdSchema,
  HEDERA_PAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  PROMPT2API_API_URL: z.string().url().default("http://localhost:4000"),
  X402_NETWORK: z.literal("hedera:testnet").default("hedera:testnet"),
  X402_ASSET: z.literal("0.0.0").default("0.0.0"),
  X402_MAX_AMOUNT: z.string().regex(/^[1-9]\d*$/).default("100000"),
  X402_EXPECTED_PAY_TO: HederaEntityIdSchema,
});

const parsed = EnvironmentSchema.parse(process.env);

export const consumerConfig = {
  payerAccountId: parsed.HEDERA_PAYER_ACCOUNT_ID,
  payerPrivateKey: parsed.HEDERA_PAYER_PRIVATE_KEY,
  apiUrl: parsed.PROMPT2API_API_URL.replace(/\/$/, ""),
  network: parsed.X402_NETWORK,
  asset: parsed.X402_ASSET,
  maxAmount: parsed.X402_MAX_AMOUNT,
  expectedPayTo: parsed.X402_EXPECTED_PAY_TO,
} as const;

export type ConsumerConfig = typeof consumerConfig;
