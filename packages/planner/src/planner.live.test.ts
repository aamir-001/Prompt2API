import { describe, expect, it } from "vitest";
import { GeminiPipelinePlanner } from "./index.js";

const runLive = process.env.RUN_LIVE_GEMINI_TEST === "1" && Boolean(process.env.GEMINI_API_KEY);

describe.runIf(runLive)("Gemini planner live integration", () => {
  it(
    "plans one supported Base ERC-4626 prompt",
    async () => {
      const planner = new GeminiPipelinePlanner({
        apiKey: process.env.GEMINI_API_KEY!,
        model: process.env.LLM_MODEL ?? "gemini-3-flash-preview",
        timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30_000),
        promptVersion: process.env.PLANNER_PROMPT_VERSION ?? "v1",
      });
      const result = await planner.plan(
        "On Base, index Deposit and Withdraw events for ERC-4626 vault 0x050ce30b927da55177a4914ec73480238bad56f0 from block 50999146 and expose hourly flows.",
      );
      expect(result).toMatchObject({ status: "ready" });
    },
    70_000,
  );
});
