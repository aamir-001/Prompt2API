import { describe, expect, it } from "vitest";
import {
  assertPipelineTransition,
  canPipelineTransition,
  IllegalPipelineTransitionError,
} from "./state-machine.js";

describe("pipeline state machine", () => {
  it("allows the complete Phase 1 happy path", () => {
    const path = [
      "DRAFT",
      "PLANNING",
      "PLAN_READY",
      "BUILD_QUEUED",
      "BUILDING",
      "VALIDATING",
      "AWAITING_APPROVAL",
      "DEPLOYING",
      "LIVE",
    ] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canPipelineTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it("rejects skipped and terminal-state transitions", () => {
    expect(() => assertPipelineTransition("DRAFT", "LIVE")).toThrow(
      IllegalPipelineTransitionError,
    );
    expect(canPipelineTransition("CANCELLED", "PLANNING")).toBe(false);
    expect(canPipelineTransition("UNSUPPORTED_SCOPE", "BUILD_QUEUED")).toBe(false);
  });
});
