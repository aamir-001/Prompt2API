import type { PipelineState } from "@prompt2api/contracts";

const transitions: Readonly<Record<PipelineState, readonly PipelineState[]>> = {
  DRAFT: ["PLANNING", "CANCELLED"],
  PLANNING: ["PLAN_READY", "NEEDS_INPUT", "UNSUPPORTED_SCOPE", "PLAN_FAILED", "CANCELLED"],
  PLAN_READY: ["BUILD_QUEUED", "CANCELLED"],
  BUILD_QUEUED: ["BUILDING", "FAILED_INTERRUPTED", "CANCELLED"],
  BUILDING: ["VALIDATING", "BUILD_FAILED", "FAILED_INTERRUPTED", "CANCELLED"],
  VALIDATING: ["AWAITING_APPROVAL", "VALIDATION_FAILED", "FAILED_INTERRUPTED", "CANCELLED"],
  AWAITING_APPROVAL: ["DEPLOYING", "BUILD_QUEUED", "CANCELLED"],
  DEPLOYING: ["LIVE", "DEPLOYMENT_FAILED", "CANCELLED"],
  LIVE: ["DEPLOYMENT_FAILED", "CANCELLED"],
  NEEDS_INPUT: ["PLANNING", "CANCELLED"],
  UNSUPPORTED_SCOPE: [],
  PLAN_FAILED: ["PLANNING", "CANCELLED"],
  BUILD_FAILED: ["BUILD_QUEUED", "CANCELLED"],
  VALIDATION_FAILED: ["BUILD_QUEUED", "CANCELLED"],
  FAILED_INTERRUPTED: ["BUILD_QUEUED", "CANCELLED"],
  DEPLOYMENT_FAILED: ["DEPLOYING", "BUILD_QUEUED", "CANCELLED"],
  CANCELLED: [],
};

export class IllegalPipelineTransitionError extends Error {
  constructor(
    readonly from: PipelineState,
    readonly to: PipelineState,
  ) {
    super(`Illegal pipeline transition: ${from} -> ${to}`);
    this.name = "IllegalPipelineTransitionError";
  }
}

export function assertPipelineTransition(
  from: PipelineState,
  to: PipelineState,
): void {
  if (!transitions[from].includes(to)) {
    throw new IllegalPipelineTransitionError(from, to);
  }
}

export function canPipelineTransition(
  from: PipelineState,
  to: PipelineState,
): boolean {
  return transitions[from].includes(to);
}
