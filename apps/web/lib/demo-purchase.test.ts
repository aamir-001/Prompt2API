import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundedInteger,
  DemoPurchaseLimiter,
  findRepositoryRoot,
  parseDemoPurchaseInput,
  runConsumerAgentPurchase,
} from "./demo-purchase.js";

describe("frontend demo purchase boundary", () => {
  it("accepts only the two paid dataset resources", () => {
    expect(parseDemoPurchaseInput("base-vault-flows", { resource: "events" }))
      .toEqual({ slug: "base-vault-flows", resource: "events" });
    expect(parseDemoPurchaseInput("base-vault-flows", { resource: "hourly-flows" }))
      .toEqual({ slug: "base-vault-flows", resource: "hourly-flows" });
  });

  it.each([
    ["../admin", { resource: "events" }],
    ["base-vault-flows", { resource: "top-depositors" }],
    ["base-vault-flows", { resource: "events", amount: "1" }],
  ])("rejects unsafe purchase input", (slug, body) => {
    expect(() => parseDemoPurchaseInput(slug, body)).toThrow();
  });

  it("enforces a per-key cooldown and a process-wide attempt cap", () => {
    const limiter = new DemoPurchaseLimiter(10_000, 2);
    expect(limiter.reserve("session-a", 1_000)).toEqual({ allowed: true });
    expect(limiter.reserve("session-a", 2_000)).toEqual({
      allowed: false,
      reason: "cooldown",
      retryAfterSeconds: 9,
    });
    expect(limiter.reserve("session-b", 2_000)).toEqual({ allowed: true });
    expect(limiter.reserve("session-c", 20_000)).toEqual({ allowed: false, reason: "limit" });
  });

  it("bounds environment-controlled limits", () => {
    expect(boundedInteger("15000", 10_000, 1_000, 60_000)).toBe(15_000);
    expect(boundedInteger("999999", 10_000, 1_000, 60_000)).toBe(10_000);
    expect(boundedInteger("nope", 25, 1, 100)).toBe(25);
  });

  it("locates the Prompt2API monorepo from either workspace", async () => {
    const root = findRepositoryRoot(process.cwd());
    const packageManifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { name?: unknown };
    expect(packageManifest.name).toBe("prompt2api");
    expect(findRepositoryRoot(`${root}/apps/web`)).toBe(root);
  });

  it("runs the restricted agent with argument-array input and parses its safe result", async () => {
    const root = await mkdtemp(join(tmpdir(), "prompt2api-demo-agent-"));
    try {
      await mkdir(join(root, "node_modules/tsx/dist"), { recursive: true });
      await mkdir(join(root, "apps/consumer-agent/src"), { recursive: true });
      await writeFile(join(root, "apps/consumer-agent/src/index.ts"), "// fixture entry\n");
      await writeFile(join(root, "node_modules/tsx/dist/cli.mjs"), `
        const [, slug] = process.argv.slice(2);
        console.log(JSON.stringify({
          data: { dataset: slug, version: 1, status: "LIVE", indexedThroughBlock: "42", amountUnit: "raw", items: [] },
          payment: { success: true, transaction: "0.0.1@1.1", network: "hedera:testnet", hashscanUrl: "https://hashscan.io/testnet/transaction/example" }
        }));
      `);
      const result = await runConsumerAgentPurchase(
        { slug: "base-vault-flows", resource: "events" },
        { repositoryRoot: root, timeoutMs: 5_000 },
      );
      expect(result.data.dataset).toBe("base-vault-flows");
      expect(result.payment.success).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
