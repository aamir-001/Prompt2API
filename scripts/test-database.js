import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "--env-file-if-exists=.env",
    "node_modules/vitest/vitest.mjs",
    "run",
    "apps/api/src/store.integration.test.ts",
    "packages/dataset-service/src/postgres.integration.test.ts",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, RUN_DATABASE_INTEGRATION: "1" },
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
