import { ApiError, type GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import {
  GeminiPipelinePlanner,
  PLANNER_RESULT_JSON_SCHEMA,
  PlannerResponseError,
  PlannerUnavailableError,
  parseAndValidatePlannerResponse,
  type PlannerMetric,
} from "./index.js";

const ADDRESS = "0x050ce30b927da55177a4914ec73480238bad56f0";
const SECOND_ADDRESS = "0xbeeff2490feffa212fac2f6553682c219e6a8845";
const THIRD_ADDRESS = "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61";

function readyResult(address = ADDRESS): string {
  return JSON.stringify({
    status: "ready",
    spec: {
      version: 1,
      displayName: "Base vault flows",
      chain: { id: "base-mainnet" },
      standard: "erc4626",
      contracts: [{ address, label: "Vault" }],
      startBlock: 0,
      events: ["Deposit", "Withdraw"],
      outputs: { rawEvents: true, hourlyFlows: true, topDepositors: false },
    },
  });
}

function plannerReturning(
  responses: Array<string | Error>,
  metrics: PlannerMetric[] = [],
): { planner: GeminiPipelinePlanner; generateContent: ReturnType<typeof vi.fn> } {
  const generateContent = vi.fn(async (_request: GenerateContentParameters) => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { text: response };
  });
  return {
    planner: new GeminiPipelinePlanner({
      apiKey: "test-only-key",
      model: "gemini-3-flash-preview",
      timeoutMs: 30_000,
      promptVersion: "v1",
      generateContent,
      recordMetric: (metric) => metrics.push(metric),
    }),
    generateContent,
  };
}

describe("GeminiPipelinePlanner", () => {
  it("derives a Gemini-supported JSON Schema from the Zod result schema", () => {
    const schema = JSON.stringify(PLANNER_RESULT_JSON_SCHEMA);
    expect(schema).toContain('"contracts"');
    expect(schema).toContain('"additionalProperties":false');
    expect(schema).not.toContain('"pattern"');
    expect(schema).not.toContain('"const"');
  });

  it("returns a validated plan for the golden ERC-4626 prompt", async () => {
    const { planner, generateContent } = plannerReturning([readyResult()]);

    await expect(
      planner.plan(
        `Index Deposit and Withdraw for Base ERC-4626 vault ${ADDRESS} from block 0 with hourly flows.`,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      spec: { startBlock: 0, contracts: [{ address: ADDRESS.toLowerCase() }] },
    });
    expect(generateContent).toHaveBeenCalledOnce();
    expect(generateContent.mock.calls[0]?.[0]).toMatchObject({
      model: "gemini-3-flash-preview",
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: PLANNER_RESULT_JSON_SCHEMA,
        httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } },
      },
    });
  });

  it.each([
    ["Track Deposit events for one Base ERC-4626 vault from block 10.", ["Deposit"], [ADDRESS], false],
    ["Track Withdraw events for my Base vault from block 20.", ["Withdraw"], [ADDRESS], false],
    ["Index deposits and withdrawals from two Base ERC-4626 vaults at block 30.", ["Deposit", "Withdraw"], [ADDRESS, SECOND_ADDRESS], false],
    ["Create raw and hourly Base vault flows from block 40.", ["Deposit", "Withdraw"], [ADDRESS], true],
    ["Normalize three ERC-4626 vaults on Base from block 50 with hourly flows.", ["Deposit", "Withdraw"], [ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS], true],
  ] as const)("accepts supported prompt variation: %s", async (prompt, events, addresses, hourlyFlows) => {
    const response = JSON.stringify({
      status: "ready",
      spec: {
        version: 1,
        displayName: "Base vault dataset",
        chain: { id: "base-mainnet" },
        standard: "erc4626",
        contracts: addresses.map((address) => ({ address })),
        startBlock: Number(prompt.match(/block (\d+)/i)?.[1] ?? 0),
        events,
        outputs: { rawEvents: true, hourlyFlows, topDepositors: false },
      },
    });
    const { planner } = plannerReturning([response]);
    await expect(planner.plan(`${prompt} ${addresses.join(", ")}`)).resolves.toMatchObject({
      status: "ready",
      spec: { events: [...events], contracts: addresses.map((address) => ({ address })) },
    });
  });

  it("returns clarification questions when the vault address is absent", async () => {
    const response = JSON.stringify({
      status: "needs_clarification",
      questions: ["Which Base ERC-4626 vault address should be indexed?"],
    });
    const { planner } = plannerReturning([response]);
    await expect(planner.plan("Index an ERC-4626 vault from block 100.")).resolves.toEqual(
      JSON.parse(response),
    );
  });

  it.each([
    "NFT transfers",
    "token swaps",
    "governance votes",
    "Ethereum mainnet ERC-4626 events",
    "arbitrary Transfer events",
  ])(
    "returns unsupported for %s",
    async (request) => {
      const response = JSON.stringify({
        status: "unsupported",
        reason: `${request} are outside the Phase 1 scope.`,
      });
      const { planner, generateContent } = plannerReturning([response]);
      await expect(planner.plan(request)).resolves.toEqual(JSON.parse(response));
      expect(generateContent).toHaveBeenCalledOnce();
    },
  );

  it("rejects a malformed address during backend validation", () => {
    expect(() => parseAndValidatePlannerResponse(readyResult("0x1234"))).toThrow();
  });

  it("rejects a non-Base chain and unexpected event during backend validation", () => {
    const chain = JSON.parse(readyResult()) as { spec: { chain: { id: string } } };
    chain.spec.chain.id = "ethereum-mainnet";
    expect(() => parseAndValidatePlannerResponse(JSON.stringify(chain))).toThrow();

    const event = JSON.parse(readyResult()) as { spec: { events: string[] } };
    event.spec.events = ["Transfer"];
    expect(() => parseAndValidatePlannerResponse(JSON.stringify(event))).toThrow();
  });

  it("rejects model-selected top-depositor output outside the planner scope", () => {
    const output = JSON.parse(readyResult()) as {
      spec: { outputs: { topDepositors: boolean } };
    };
    output.spec.outputs.topDepositors = true;
    expect(() => parseAndValidatePlannerResponse(JSON.stringify(output))).toThrow(
      PlannerResponseError,
    );
  });

  it("rejects unexpected model fields with strict Zod parsing", () => {
    const parsed = JSON.parse(readyResult()) as Record<string, unknown>;
    parsed.command = "not allowed";
    expect(() => parseAndValidatePlannerResponse(JSON.stringify(parsed))).toThrow();
  });

  it("does not retry a schema-valid unsupported result", async () => {
    const response = JSON.stringify({ status: "unsupported", reason: "NFTs are unsupported." });
    const { planner, generateContent } = plannerReturning([response, readyResult()]);
    await expect(planner.plan("Index NFTs")).resolves.toEqual(JSON.parse(response));
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it("retries one timeout and then succeeds", async () => {
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const metrics: PlannerMetric[] = [];
    const { planner, generateContent } = plannerReturning([timeout, readyResult()], metrics);

    await expect(planner.plan("valid prompt")).resolves.toMatchObject({ status: "ready" });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(metrics).toEqual([
      expect.objectContaining({ resultStatus: "ready", attempts: 2 }),
    ]);
  });

  it("maps exhausted free-tier quota to PLANNER_UNAVAILABLE after one retry", async () => {
    const quota = new ApiError({ status: 429, message: "RESOURCE_EXHAUSTED: free tier quota" });
    const metrics: PlannerMetric[] = [];
    const { planner, generateContent } = plannerReturning([quota, quota], metrics);

    await expect(planner.plan("valid prompt")).rejects.toMatchObject({
      code: "PLANNER_UNAVAILABLE",
    });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(metrics).toEqual([
      expect.objectContaining({ resultStatus: "error", attempts: 2 }),
    ]);
  });

  it("does not retry malformed structured output", async () => {
    const { planner, generateContent } = plannerReturning([
      JSON.stringify({ status: "ready", surprise: true }),
      readyResult(),
    ]);
    await expect(planner.plan("valid prompt")).rejects.toThrow();
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it("rejects implementation text in free-form fields", () => {
    expect(() =>
      parseAndValidatePlannerResponse(
        JSON.stringify({ status: "unsupported", reason: "Run npm install." }),
      ),
    ).toThrow(PlannerResponseError);
  });

  it("rejects prompts over the configured limit before calling Gemini", async () => {
    const { planner, generateContent } = plannerReturning([readyResult()]);
    await expect(planner.plan("x".repeat(4_001))).rejects.toThrow("1-4000");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("uses a generic unavailable error without exposing provider details", async () => {
    const error = Object.assign(new Error("temporary unavailable secret payload"), { status: 503 });
    const { planner } = plannerReturning([error, error]);
    await expect(planner.plan("valid prompt")).rejects.toEqual(
      expect.objectContaining<Partial<PlannerUnavailableError>>({
        message: "The pipeline planner is temporarily unavailable",
      }),
    );
  });
});
