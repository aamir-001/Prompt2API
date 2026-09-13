import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DATASET_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type DemoPaidResource = "events" | "hourly-flows";

export interface DemoPurchaseInput {
  slug: string;
  resource: DemoPaidResource;
}

export interface DemoPurchaseResult {
  data: {
    dataset: string;
    version: number;
    status: "LIVE";
    indexedThroughBlock: string;
    amountUnit: "raw";
    items: unknown[];
  };
  payment: {
    success: true;
    transaction: string;
    network: "hedera:testnet";
    amount?: string;
    payer?: string;
    hashscanUrl: string;
  };
}

export interface DemoPurchaseReservation {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: "cooldown" | "limit";
}

export class DemoPurchaseLimiter {
  private readonly lastAttemptByKey = new Map<string, number>();
  private attempts = 0;

  constructor(
    private readonly cooldownMs: number,
    private readonly maxAttempts: number,
  ) {}

  reserve(key: string, now = Date.now()): DemoPurchaseReservation {
    if (this.attempts >= this.maxAttempts) {
      return { allowed: false, reason: "limit" };
    }
    const lastAttempt = this.lastAttemptByKey.get(key);
    if (lastAttempt !== undefined && now - lastAttempt < this.cooldownMs) {
      return {
        allowed: false,
        reason: "cooldown",
        retryAfterSeconds: Math.max(1, Math.ceil((this.cooldownMs - (now - lastAttempt)) / 1_000)),
      };
    }
    this.attempts += 1;
    this.lastAttemptByKey.set(key, now);
    return { allowed: true };
  }
}

export function parseDemoPurchaseInput(slug: string, body: unknown): DemoPurchaseInput {
  if (!DATASET_SLUG.test(slug) || slug.length > 120) {
    throw new Error("Invalid dataset slug");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "resource")
  ) {
    throw new Error("Invalid purchase request");
  }
  const resource = (body as { resource?: unknown }).resource;
  if (resource !== "events" && resource !== "hourly-flows") {
    throw new Error("Invalid paid resource");
  }
  return { slug, resource };
}

export async function runConsumerAgentPurchase(
  input: DemoPurchaseInput,
  options: { repositoryRoot?: string; timeoutMs?: number } = {},
): Promise<DemoPurchaseResult> {
  const repositoryRoot = options.repositoryRoot ?? findRepositoryRoot(process.cwd());
  const consumerDirectory = resolve(repositoryRoot, "apps/consumer-agent");
  const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs");
  const consumerEntry = resolve(consumerDirectory, "src/index.ts");
  const { stdout } = await execFileAsync(
    process.execPath,
    [tsxCli, consumerEntry, input.slug, input.resource],
    {
      cwd: consumerDirectory,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const parsed = JSON.parse(stdout) as Partial<DemoPurchaseResult>;
  if (
    parsed.payment?.success !== true ||
    parsed.payment.network !== "hedera:testnet" ||
    parsed.data?.dataset !== input.slug ||
    parsed.data.status !== "LIVE" ||
    !Array.isArray(parsed.data.items)
  ) {
    throw new Error("Consumer agent returned an invalid purchase result");
  }
  return parsed as DemoPurchaseResult;
}

export function findRepositoryRoot(currentDirectory: string): string {
  for (const candidate of [currentDirectory, resolve(currentDirectory, "../..")]) {
    if (existsSync(resolve(candidate, "apps/consumer-agent/src/index.ts"))) return candidate;
  }
  throw new Error("Unable to locate the Prompt2API repository root");
}

export function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
