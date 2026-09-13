import { spawnSync } from "node:child_process";

const liveTests = {
  gemini: {
    flag: "RUN_LIVE_GEMINI_TEST",
    file: "packages/planner/src/planner.live.test.ts",
  },
  substreams: {
    flag: "RUN_LIVE_SUBSTREAMS_TEST",
    file: "packages/substreams-runner/src/live-golden.integration.test.ts",
  },
};

const name = process.argv[2];
const selected = liveTests[name];
if (selected === undefined) {
  throw new Error("Usage: node scripts/test-live.js <gemini|substreams>");
}

const result = spawnSync(
  process.execPath,
  [
    "--env-file-if-exists=.env",
    "node_modules/vitest/vitest.mjs",
    "run",
    selected.file,
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, [selected.flag]: "1" },
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
