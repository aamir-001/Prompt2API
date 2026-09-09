import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseValidationJsonl, SubstreamsRunner } from "./index.js";

const runLive =
  process.env.RUN_LIVE_SUBSTREAMS_TEST === "1" &&
  Boolean(process.env.SUBSTREAMS_API_TOKEN);

describe.runIf(runLive)("golden Base Substreams integration", () => {
  it(
    "builds the package and returns a known onchain ERC-4626 event",
    async () => {
      const repositoryRoot = resolve(import.meta.dirname, "../../..");
      const projectDirectory = resolve(repositoryRoot, "spike/erc4626-manual");
      const runner = new SubstreamsRunner({
        artifactRoot: resolve(repositoryRoot, "spike"),
        executable: process.env.SUBSTREAMS_CLI_PATH ?? "substreams",
      });

      const build = await runner.build({ projectDirectory, timeoutMs: 300_000 });
      expect(build.exitCode, build.stderr).toBe(0);

      const validation = await runner.validate({
        projectDirectory,
        endpoint: process.env.SUBSTREAMS_ENDPOINT ?? "base-mainnet.streamingfast.io:443",
        startBlock: 50_999_146,
        stopBlock: 50_999_246,
        apiToken: process.env.SUBSTREAMS_API_TOKEN!,
        timeoutMs: 180_000,
      });
      expect(validation.exitCode, validation.stderr).toBe(0);

      const preview = parseValidationJsonl(validation.stdout);
      expect(preview.events.length).toBeGreaterThan(0);
      expect(preview.events.map(({ transactionHash }) => transactionHash)).toContain(
        "0xa88efc19760e12e3773270f004ede724b58d9a82d7cef2dd0d9adf811a275095",
      );
    },
    500_000,
  );
});
