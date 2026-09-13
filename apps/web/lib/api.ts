export type PipelineState =
  | "DRAFT" | "PLANNING" | "PLAN_READY" | "BUILD_QUEUED" | "BUILDING"
  | "VALIDATING" | "AWAITING_APPROVAL" | "DEPLOYING" | "LIVE"
  | "NEEDS_INPUT" | "UNSUPPORTED_SCOPE" | "PLAN_FAILED" | "BUILD_FAILED"
  | "VALIDATION_FAILED" | "FAILED_INTERRUPTED" | "DEPLOYMENT_FAILED" | "CANCELLED";

export interface Contract {
  address: string;
  label?: string;
}

export interface PipelineSpec {
  version: 1;
  displayName: string;
  chain: { id: "base-mainnet" };
  standard: "erc4626";
  contracts: Contract[];
  startBlock: number;
  events: Array<"Deposit" | "Withdraw">;
  outputs: { rawEvents: true; hourlyFlows: boolean; topDepositors: boolean };
}

export interface Pipeline {
  pipelineId: string;
  status: PipelineState;
  originalPrompt: string;
  spec: PipelineSpec | null;
  derivedPlan: {
    importedPackage: string;
    modules: string[];
    filterExpression: string;
    eventTopics: string[];
    schemaName: string;
  } | null;
  slug: string | null;
  activeVersion: number;
  contracts: Contract[];
  versions: Array<{
    version: number;
    configurationHash: string;
    packageHash: string | null;
    validationStartBlock: number | null;
    validationStopBlock: number | null;
    validationResult: ValidationResult | null;
  }>;
  transitions: Array<{ toState: PipelineState; reason: string; createdAt: string }>;
  validationOutcome: {
    status: "NO_ACTIVITY_IN_SAMPLE";
    message: string;
    startBlock: number | null;
    stopBlock: number | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationEvent {
  eventId: string;
  vaultAddress: string;
  eventType: "DEPOSIT" | "WITHDRAW";
  senderAddress: string;
  ownerAddress: string;
  receiverAddress?: string;
  assetsRaw: string;
  sharesRaw: string;
  blockNumber: string;
  blockTime: string;
  transactionHash: string;
  logIndex: number;
}

export interface ValidationResult {
  eventCount: number;
  preview: ValidationEvent[];
  sourceBlocks: number[];
  checklist: Record<string, boolean>;
}

export interface Preview {
  pipelineId: string;
  status: PipelineState;
  configurationHash: string | null;
  packageHash: string | null;
  validation: ValidationResult | null;
}

export interface Run {
  id: string;
  stage: string;
  status: string;
  commandLabel: string | null;
  stdout: string | null;
  stderr: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiRequestInit = RequestInit & {
  acceptedStatuses?: readonly number[];
};

export async function api<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const { acceptedStatuses = [], ...requestInit } = init ?? {};
  const response = await fetch(`/control${path}`, {
    ...requestInit,
    headers: { "content-type": "application/json", ...requestInit.headers },
    cache: "no-store",
  });
  const data = await response.json().catch(() => null) as
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new ApiError(
      response.status,
      data?.error?.code ?? "REQUEST_FAILED",
      data?.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return data as T;
}

export function shortHex(value: string, left = 8, right = 6): string {
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

export function formatRaw(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
