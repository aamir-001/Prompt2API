import { cp, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { SubstreamsRunner } from "../packages/substreams-runner/src/index.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifactRoot = resolve(repositoryRoot, "generated");
const sourceDirectory = resolve(artifactRoot, "golden-erc4626");
const projectDirectory = resolve(artifactRoot, ".warm-project");

await rm(projectDirectory, { recursive: true, force: true });
try {
  await cp(sourceDirectory, projectDirectory, {
    recursive: true,
    filter(sourcePath) {
      const path = relative(sourceDirectory, sourcePath).replaceAll("\\", "/");
      return path === "" || !(
        path === "target" ||
        path.startsWith("target/") ||
        path.startsWith("src/pb/") ||
        path === "src/abi/erc4626.rs" ||
        path.endsWith(".spkg")
      );
    },
  });

  const runner = new SubstreamsRunner({ artifactRoot });
  const result = await runner.build({
    projectDirectory,
    timeoutMs: 10 * 60 * 1_000,
    onOutput(stream, chunk) {
      (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
    },
  });

  if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
    throw new Error(
      result.timedOut
        ? "Substreams cache warm-up timed out"
        : `Substreams cache warm-up failed with exit code ${String(result.exitCode)}`,
    );
  }

  console.log(`Shared Substreams build cache is ready (${result.durationMs} ms).`);
} finally {
  await rm(projectDirectory, { recursive: true, force: true });
}
