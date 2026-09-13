import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { PipelineSpec } from "@prompt2api/contracts";
import {
  derivePipelineConfig,
  type DerivedPipelineConfig,
} from "@prompt2api/pipeline-config";
import { z } from "zod";

export const TEMPLATE_VERSION = "v1";

export const FIXED_TEMPLATE_FILES = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "buf.gen.yaml",
  "build.rs",
  "proto/prompt2api/erc4626/v1/vault.proto",
  "src/lib.rs",
  "src/abi/mod.rs",
  "abi/erc4626.json",
  "schema.sql",
] as const;

export interface RenderPipelineOptions {
  spec: PipelineSpec;
  pipelineId: string;
  pipelineVersion?: number;
  templateRoot: string;
  artifactRoot: string;
  artifactSubdirectory: string;
}

export interface ArtifactManifest {
  version: 1;
  templateVersion: typeof TEMPLATE_VERSION;
  pipelineId: string;
  pipelineVersion: number;
  packageName: string;
  schemaName: string;
  specSha256: string;
  files: Array<{ path: string; sha256: string }>;
}

export interface RenderedPipeline {
  outputDirectory: string;
  config: DerivedPipelineConfig;
  manifest: ArtifactManifest;
}

const ArtifactManifestSchema = z.strictObject({
  version: z.literal(1),
  templateVersion: z.literal(TEMPLATE_VERSION),
  pipelineId: z.string().regex(/^pl_[a-z0-9]{8,32}$/),
  pipelineVersion: z.number().int().positive(),
  packageName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  schemaName: z.string().regex(/^dataset_pl_[a-z0-9]{8,32}$/),
  specSha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

export interface ArtifactVerification {
  valid: boolean;
  errors: string[];
  manifest: ArtifactManifest;
  manifestSha256: string;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveWithin(root: string, relativePath: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, relativePath);
  const pathFromRoot = relative(rootPath, target);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    resolve(pathFromRoot) === pathFromRoot
  ) {
    throw new Error("Artifact path must resolve to a child of ARTIFACT_ROOT");
  }
  return target;
}

function assertSafeArtifactSubdirectory(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(value)) {
    throw new Error("Unsafe artifact subdirectory");
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]<>]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function renderTemplate(
  source: string,
  values: Readonly<Record<string, string>>,
): string {
  const rendered = source.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Unknown template placeholder: ${key}`);
    }
    return value;
  });
  if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) {
    throw new Error("Unresolved template placeholder");
  }
  return rendered;
}

async function assertDirectoryEmpty(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) {
    throw new Error(`Artifact directory is not empty: ${directory}`);
  }
}

export async function renderPipeline(
  options: RenderPipelineOptions,
): Promise<RenderedPipeline> {
  assertSafeArtifactSubdirectory(options.artifactSubdirectory);
  const templateRoot = resolve(options.templateRoot);
  const outputDirectory = resolveWithin(
    options.artifactRoot,
    options.artifactSubdirectory,
  );
  const config = derivePipelineConfig(options.spec, {
    pipelineId: options.pipelineId,
    ...(options.pipelineVersion === undefined
      ? {}
      : { pipelineVersion: options.pipelineVersion }),
  });

  await assertDirectoryEmpty(outputDirectory);

  for (const templatePath of FIXED_TEMPLATE_FILES) {
    const sourcePath = resolveWithin(templateRoot, templatePath);
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
      throw new Error(`Template allowlist entry is not a file: ${templatePath}`);
    }
    const destinationPath = resolveWithin(outputDirectory, templatePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  const manifestTemplate = await readFile(
    resolveWithin(templateRoot, "substreams.yaml.tmpl"),
    "utf8",
  );
  const readmeTemplate = await readFile(
    resolveWithin(templateRoot, "README.template.md"),
    "utf8",
  );
  const filterSingleLine = config.filter.replace("\n", " ");
  const vaults = config.normalizedSpec.contracts
    .map(({ address, label }) =>
      label === undefined
        ? `\`${address}\``
        : `${escapeMarkdown(label)} (\`${address}\`)`,
    )
    .join(", ");

  await writeFile(
    resolveWithin(outputDirectory, "substreams.yaml"),
    renderTemplate(manifestTemplate, {
      PACKAGE_NAME: config.packageName,
      START_BLOCK: String(config.normalizedSpec.startBlock),
      FILTER_SINGLE_LINE: filterSingleLine,
    }),
  );
  await writeFile(
    resolveWithin(outputDirectory, "README.generated.md"),
    renderTemplate(readmeTemplate, {
      DISPLAY_NAME: escapeMarkdown(config.normalizedSpec.displayName),
      PIPELINE_ID: config.pipelineId,
      PIPELINE_VERSION: String(config.pipelineVersion),
      START_BLOCK: String(config.normalizedSpec.startBlock),
      EVENTS: config.normalizedSpec.events.map(escapeMarkdown).join(", "),
      VAULTS: vaults,
      FILTER_MULTILINE: config.filter,
    }),
  );

  const specContent = stableJson(config.normalizedSpec);
  await writeFile(resolveWithin(outputDirectory, "pipeline-spec.json"), specContent);

  const artifactFiles = [
    ...FIXED_TEMPLATE_FILES,
    "substreams.yaml",
    "README.generated.md",
    "pipeline-spec.json",
  ].sort();
  const files = await Promise.all(
    artifactFiles.map(async (path) => ({
      path,
      sha256: sha256(await readFile(resolveWithin(outputDirectory, path))),
    })),
  );
  const manifest: ArtifactManifest = {
    version: 1,
    templateVersion: TEMPLATE_VERSION,
    pipelineId: config.pipelineId,
    pipelineVersion: config.pipelineVersion,
    packageName: config.packageName,
    schemaName: config.schemaName,
    specSha256: sha256(specContent),
    files,
  };
  await writeFile(
    resolveWithin(outputDirectory, "artifact-manifest.json"),
    stableJson(manifest),
  );

  return { outputDirectory, config, manifest };
}

export async function verifyRenderedPipeline(
  outputDirectory: string,
): Promise<ArtifactVerification> {
  const manifestBytes = await readFile(
    resolveWithin(outputDirectory, "artifact-manifest.json"),
  );
  const manifest = ArtifactManifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  ) as ArtifactManifest;
  const errors: string[] = [];
  const expectedPaths = [
    ...FIXED_TEMPLATE_FILES,
    "README.generated.md",
    "pipeline-spec.json",
    "substreams.yaml",
  ].sort();
  const actualPaths = manifest.files.map(({ path }) => path).sort();
  if (new Set(actualPaths).size !== actualPaths.length) {
    errors.push("Artifact manifest contains duplicate paths");
  }
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    errors.push("Artifact manifest file allowlist does not match the template");
  }
  for (const file of manifest.files) {
    try {
      const actualHash = sha256(await readFile(resolveWithin(outputDirectory, file.path)));
      if (actualHash !== file.sha256) errors.push(`Hash mismatch: ${file.path}`);
    } catch {
      errors.push(`Missing artifact: ${file.path}`);
    }
  }
  const specEntry = manifest.files.find(({ path }) => path === "pipeline-spec.json");
  if (specEntry?.sha256 !== manifest.specSha256) {
    errors.push("Pipeline specification hash does not match artifact manifest");
  }
  return {
    valid: errors.length === 0,
    errors,
    manifest,
    manifestSha256: sha256(manifestBytes),
  };
}
