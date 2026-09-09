import { isAddress } from "viem";
import { z } from "zod";

export const PIPELINE_EVENTS = ["Deposit", "Withdraw"] as const;

export const PipelineContractSchema = z.strictObject({
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "Expected a 20-byte 0x-prefixed address"),
  label: z.string().min(1).max(60).optional(),
});

export const PipelineSpecSchema = z.strictObject({
  version: z.literal(1),
  displayName: z.string().min(1).max(100),
  chain: z.strictObject({
    id: z.literal("base-mainnet"),
  }),
  standard: z.literal("erc4626"),
  contracts: z.array(PipelineContractSchema).min(1).max(3),
  startBlock: z.number().int().nonnegative().safe(),
  events: z.array(z.enum(PIPELINE_EVENTS)).min(1).max(2),
  outputs: z.strictObject({
    rawEvents: z.literal(true),
    hourlyFlows: z.boolean(),
    topDepositors: z.boolean(),
  }),
});

export type PipelineSpec = z.infer<typeof PipelineSpecSchema>;

export const PIPELINE_STATES = [
  "DRAFT",
  "PLANNING",
  "PLAN_READY",
  "BUILD_QUEUED",
  "BUILDING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "DEPLOYING",
  "LIVE",
  "NEEDS_INPUT",
  "UNSUPPORTED_SCOPE",
  "PLAN_FAILED",
  "BUILD_FAILED",
  "VALIDATION_FAILED",
  "FAILED_INTERRUPTED",
  "DEPLOYMENT_FAILED",
  "CANCELLED",
] as const;

export const PipelineStateSchema = z.enum(PIPELINE_STATES);
export type PipelineState = z.infer<typeof PipelineStateSchema>;

export const PlannerResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    spec: PipelineSpecSchema,
  }),
  z.strictObject({
    status: z.literal("needs_clarification"),
    questions: z.array(z.string().min(1).max(300)).min(1).max(5),
  }),
  z.strictObject({
    status: z.literal("unsupported"),
    reason: z.string().min(1).max(500),
  }),
]);

export type PlannerResult = z.infer<typeof PlannerResultSchema>;

export interface PipelinePlanner {
  plan(prompt: string): Promise<PlannerResult>;
}

export const ApprovalRequestSchema = z.strictObject({
  configurationHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  packageHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export function parsePipelineSpec(input: unknown): PipelineSpec {
  const spec = PipelineSpecSchema.parse(input);
  const issues: Array<{ path: PropertyKey[]; message: string }> = [];
  const seenAddresses = new Set<string>();
  const seenEvents = new Set<string>();

  for (const [index, contract] of spec.contracts.entries()) {
    if (!isAddress(contract.address, { strict: false })) {
      issues.push({
        path: ["contracts", index, "address"],
        message: "Invalid EVM address",
      });
    }

    const normalized = contract.address.toLowerCase();
    if (seenAddresses.has(normalized)) {
      issues.push({
        path: ["contracts", index, "address"],
        message: "Contract addresses must be unique",
      });
    }
    seenAddresses.add(normalized);

    if (contract.label !== undefined && contract.label.trim() !== contract.label) {
      issues.push({
        path: ["contracts", index, "label"],
        message: "Contract labels must already be trimmed",
      });
    }
  }

  for (const [index, event] of spec.events.entries()) {
    if (seenEvents.has(event)) {
      issues.push({
        path: ["events", index],
        message: "Events must be unique",
      });
    }
    seenEvents.add(event);
  }

  if (issues.length > 0) {
    throw new z.ZodError(
      issues.map((issue) => ({
        code: "custom" as const,
        path: issue.path,
        message: issue.message,
        input,
      })),
    );
  }

  return spec;
}

export function normalizePipelineSpec(spec: PipelineSpec): PipelineSpec {
  return {
    ...spec,
    contracts: spec.contracts.map((contract) => ({
      ...contract,
      address: contract.address.toLowerCase(),
    })),
  };
}
