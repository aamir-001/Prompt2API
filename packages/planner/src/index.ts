import {
  ApiError,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentParameters,
} from "@google/genai";
import {
  PlannerResultSchema,
  normalizePipelineSpec,
  parsePipelineSpec,
  type PipelinePlanner,
  type PlannerResult,
} from "@prompt2api/contracts";
import { z } from "zod";

export const DEFAULT_MAX_PROMPT_LENGTH = 4_000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export interface PlannerMetric {
  model: string;
  promptVersion: string;
  latencyMs: number;
  resultStatus: PlannerResult["status"] | "error";
  attempts: number;
}

export interface GeminiPipelinePlannerOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  promptVersion: string;
  maxPromptLength?: number;
  recordMetric?: (metric: PlannerMetric) => void;
  generateContent?: (
    request: GenerateContentParameters,
  ) => Promise<{ readonly text: string | undefined }>;
}

export class PlannerUnavailableError extends Error {
  readonly code = "PLANNER_UNAVAILABLE";

  constructor(message = "The pipeline planner is temporarily unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "PlannerUnavailableError";
  }
}

export class PlannerResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlannerResponseError";
  }
}

export class GeminiPipelinePlanner implements PipelinePlanner {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #promptVersion: string;
  readonly #maxPromptLength: number;
  readonly #recordMetric: (metric: PlannerMetric) => void;
  readonly #generateContent: GeminiPipelinePlannerOptions["generateContent"];

  constructor(options: GeminiPipelinePlannerOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("GEMINI_API_KEY is required");
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("LLM timeout must be a positive integer");
    }

    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs;
    this.#promptVersion = options.promptVersion;
    this.#maxPromptLength = options.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;
    this.#recordMetric = options.recordMetric ?? (() => undefined);

    if (options.generateContent !== undefined) {
      this.#generateContent = options.generateContent;
    } else {
      const client = new GoogleGenAI({
        apiKey: options.apiKey,
        httpOptions: {
          timeout: options.timeoutMs,
          retryOptions: { attempts: 1 },
        },
      });
      this.#generateContent = (request) => client.models.generateContent(request);
    }
  }

  async plan(prompt: string): Promise<PlannerResult> {
    if (prompt.trim().length === 0 || prompt.length > this.#maxPromptLength) {
      throw new Error(`Prompt must contain 1-${this.#maxPromptLength} characters`);
    }

    const startedAt = performance.now();
    let attempts = 0;

    try {
      while (attempts < 2) {
        attempts += 1;
        try {
          const response = await this.#generateContent!({
            model: this.#model,
            contents: prompt,
            config: {
              systemInstruction: SYSTEM_INSTRUCTION.replace(
                "{{PROMPT_VERSION}}",
                this.#promptVersion,
              ),
              responseMimeType: "application/json",
              responseJsonSchema: PLANNER_RESULT_JSON_SCHEMA,
              maxOutputTokens: 1_500,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              httpOptions: {
                timeout: this.#timeoutMs,
                retryOptions: { attempts: 1 },
              },
            },
          });
          const result = parseAndValidatePlannerResponse(response.text);
          this.#record(startedAt, result.status, attempts);
          return result;
        } catch (error) {
          if (attempts < 2 && isTransientProviderError(error)) continue;
          if (isTransientProviderError(error)) {
            throw new PlannerUnavailableError(undefined, { cause: error });
          }
          if (isProviderCallError(error)) {
            throw new PlannerUnavailableError(undefined, { cause: error });
          }
          throw error;
        }
      }

      throw new PlannerUnavailableError();
    } catch (error) {
      this.#record(startedAt, "error", attempts);
      throw error;
    }
  }

  #record(
    startedAt: number,
    resultStatus: PlannerMetric["resultStatus"],
    attempts: number,
  ): void {
    this.#recordMetric({
      model: this.#model,
      promptVersion: this.#promptVersion,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      resultStatus,
      attempts,
    });
  }
}

export function parseAndValidatePlannerResponse(text: string | undefined): PlannerResult {
  if (text === undefined || text.trim().length === 0) {
    throw new PlannerResponseError("Gemini returned an empty planner response");
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new PlannerResponseError("Gemini returned invalid JSON", { cause: error });
  }

  try {
    const result = PlannerResultSchema.parse(input);
    assertNoGeneratedImplementationText(result);
    if (result.status !== "ready") return result;
    if (result.spec.outputs.topDepositors) {
      throw new PlannerResponseError(
        "Gemini selected an output that is outside the Phase 1 planner scope",
      );
    }

    return {
      status: "ready",
      spec: normalizePipelineSpec(parsePipelineSpec(result.spec)),
    };
  } catch (error) {
    if (error instanceof PlannerResponseError) throw error;
    throw new PlannerResponseError(
      "Gemini returned a planner response that failed backend validation",
      { cause: error },
    );
  }
}

export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof ApiError) return RETRYABLE_STATUS_CODES.has(error.status);
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (typeof candidate.status === "number" && RETRYABLE_STATUS_CODES.has(candidate.status)) {
    return true;
  }
  if (candidate.code === "ETIMEDOUT" || candidate.code === "ECONNRESET") return true;
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return true;
  if (typeof candidate.message === "string" && /timed?\s*out|temporary unavailable|fetch failed/i.test(candidate.message)) {
    return true;
  }
  return "cause" in candidate && isTransientProviderError(candidate.cause);
}

function isProviderCallError(error: unknown): boolean {
  if (error instanceof PlannerResponseError || error instanceof z.ZodError) return false;
  if (error instanceof ApiError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown; cause?: unknown };
  return (
    typeof candidate.status === "number" ||
    typeof candidate.code === "string" ||
    (candidate.cause !== undefined && isProviderCallError(candidate.cause))
  );
}

const SYSTEM_INSTRUCTION = `You are the Prompt2API Phase 1 pipeline planner ({{PROMPT_VERSION}}).
Return only the structured result required by the supplied JSON Schema.

Supported scope is deliberately narrow:
- chain: Base mainnet only (chain.id must be "base-mainnet")
- standard: ERC-4626 vaults only
- events: Deposit and/or Withdraw only, using exactly "Deposit" and "Withdraw"
- contracts: one to three vault addresses explicitly supplied by the user; copy them exactly and never invent one
- startBlock: a supplied non-negative integer
- outputs: rawEvents must be true; hourlyFlows may be requested; topDepositors must be false in Phase 1

If the request asks for another chain, NFT data, swaps, governance, another contract standard, or any other event, return status "unsupported" with a short plain-language reason.
If a vault address, start block, or requested event selection is missing or ambiguous, return status "needs_clarification" with focused questions. Do not guess.
If supported, return status "ready". Use version 1 and a short plain-language displayName. Do not add fields.

Never return source code, Rust, SQL, shell commands, command lines, package names, dependency names, or file paths in any field.`;

const SUPPORTED_JSON_SCHEMA_KEYS = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

function supportedJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(supportedJsonSchema);
  if (typeof value !== "object" || value === null) return value;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "const") {
      output.enum = [nested];
    } else if ((key === "properties" || key === "$defs") && typeof nested === "object" && nested !== null) {
      output[key] = Object.fromEntries(
        Object.entries(nested).map(([name, schema]) => [name, supportedJsonSchema(schema)]),
      );
    } else if (SUPPORTED_JSON_SCHEMA_KEYS.has(key)) {
      output[key] = supportedJsonSchema(nested);
    }
  }
  return output;
}

export const PLANNER_RESULT_JSON_SCHEMA = supportedJsonSchema(
  z.toJSONSchema(PlannerResultSchema),
);

function assertNoGeneratedImplementationText(result: PlannerResult): void {
  const textValues =
    result.status === "ready"
      ? [result.spec.displayName, ...result.spec.contracts.flatMap(({ label }) => label ?? [])]
      : result.status === "needs_clarification"
        ? result.questions
        : [result.reason];

  const forbidden = /```|(?:^|\s)(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|cargo|npm|pnpm|yarn|substreams)\b|(?:^|\s)(?:\.\.\/|\.\/|[A-Za-z]:\\)|\.(?:rs|sql|sh|ps1|toml|yaml|yml)(?:\s|$)/i;
  if (textValues.some((value) => forbidden.test(value))) {
    throw new PlannerResponseError("Planner response contained forbidden implementation text");
  }
}
