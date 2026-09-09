import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web API client", () => {
  it("returns an expected 422 domain result to the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { pipelineId: "pl_unsupported", status: "UNSUPPORTED_SCOPE" },
          { status: 422 },
        ),
      ),
    );

    await expect(
      api<{ pipelineId: string; status: string }>("/v1/pipelines/plan", {
        method: "POST",
        acceptedStatuses: [422],
      }),
    ).resolves.toEqual({
      pipelineId: "pl_unsupported",
      status: "UNSUPPORTED_SCOPE",
    });
  });

  it("still throws for unaccepted HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "PLANNER_UNAVAILABLE", message: "Try later" } },
          { status: 503 },
        ),
      ),
    );

    await expect(api("/v1/pipelines/plan")).rejects.toEqual(
      expect.objectContaining<Partial<ApiError>>({
        status: 503,
        code: "PLANNER_UNAVAILABLE",
        message: "Try later",
      }),
    );
  });
});
