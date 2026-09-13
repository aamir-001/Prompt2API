import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PlannerResultSchema,
  normalizePipelineSpec,
  parsePipelineSpec,
  type PipelineSpec,
  type PipelinePlanner,
} from "@prompt2api/contracts";
import { renderPipeline } from "@prompt2api/generator";
import { derivePipelineConfig } from "@prompt2api/pipeline-config";
import type { ControlStore, DerivedPlan, PipelineSnapshot } from "./store.js";
import { assertPipelineTransition } from "./state-machine.js";

const MAX_PROMPT_LENGTH = 4_000;
export interface PipelineServiceOptions {
  store: ControlStore;
  planner: PipelinePlanner;
  artifactRoot: string;
  templateRoot: string;
  validationBlockCount: number;
  createPipelineId?: () => string;
}

export interface PlanOverrides {
  contracts?: PipelineSpec["contracts"] | undefined;
  startBlock?: number | null | undefined;
}

export class PipelineService {
  readonly #store: ControlStore;
  readonly #planner: PipelinePlanner;
  readonly #artifactRoot: string;
  readonly #templateRoot: string;
  readonly #validationBlockCount: number;
  readonly #createPipelineId: () => string;

  constructor(options: PipelineServiceOptions) {
    this.#store = options.store;
    this.#planner = options.planner;
    this.#artifactRoot = options.artifactRoot;
    this.#templateRoot = options.templateRoot;
    this.#validationBlockCount = options.validationBlockCount;
    this.#createPipelineId =
      options.createPipelineId ?? (() => `pl_${randomBytes(5).toString("hex")}`);
  }

  async plan(prompt: string, overrides?: PlanOverrides): Promise<PipelineSnapshot> {
    if (prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Prompt must contain 1-${MAX_PROMPT_LENGTH} characters`);
    }
    const pipelineId = this.#createPipelineId();
    await this.#store.createPipeline(pipelineId, prompt);
    await this.#store.transition(pipelineId, "PLANNING", "Planning started");

    try {
      const plannerPrompt = addStructuredOverrides(prompt, overrides);
      const result = PlannerResultSchema.parse(await this.#planner.plan(plannerPrompt));
      if (result.status === "needs_clarification") {
        await this.#store.transition(
          pipelineId,
          "NEEDS_INPUT",
          result.questions.join(" | "),
        );
      } else if (result.status === "unsupported") {
        await this.#store.transition(
          pipelineId,
          "UNSUPPORTED_SCOPE",
          result.reason,
        );
      } else {
        const spec = applyStructuredOverrides(result.spec, overrides);
        const config = derivePipelineConfig(spec, { pipelineId });
        const derivedPlan: DerivedPlan = {
          importedPackage: "ethereum-common@v0.3.3",
          modules: [
            "ethereum_common:filtered_events",
            "map_vault_events",
            "db_out",
          ],
          filterExpression: config.filter,
          eventTopics: config.eventTopics,
          schemaName: config.schemaName,
        };
        return this.#store.recordReadyPlan(
          pipelineId,
          config.normalizedSpec,
          derivedPlan,
          config.slug,
        );
      }
    } catch (error) {
      const current = await this.#store.getPipeline(pipelineId);
      if (current?.state === "PLANNING") {
        await this.#store.transition(
          pipelineId,
          "PLAN_FAILED",
          error instanceof Error ? error.message : "Planning failed",
        );
      }
      throw error;
    }

    const pipeline = await this.#store.getPipeline(pipelineId);
    if (pipeline === null) throw new Error("Pipeline disappeared after planning");
    return pipeline;
  }

  async queueBuild(
    pipelineId: string,
    options?: { startBlock?: number | undefined },
  ): Promise<PipelineSnapshot> {
    const pipeline = await this.#store.getPipeline(pipelineId);
    if (pipeline === null) throw new Error("Pipeline not found");
    if (pipeline.spec === null) throw new Error("Pipeline has no validated specification");
    if (
      pipeline.state === "BUILD_QUEUED" ||
      pipeline.state === "BUILDING" ||
      pipeline.state === "VALIDATING"
    ) {
      return pipeline;
    }
    assertPipelineTransition(pipeline.state, "BUILD_QUEUED");
    const spec = options?.startBlock === undefined
      ? pipeline.spec
      : normalizePipelineSpec(parsePipelineSpec({
          ...pipeline.spec,
          startBlock: options.startBlock,
        }));
    if (options?.startBlock !== undefined) {
      await this.#store.updatePipelineSpec(pipelineId, spec);
    }
    const version = pipeline.activeVersion + 1;
    // Rendering happens before the version is committed to the control store. If
    // the request is interrupted during that small window, its files must not
    // block a later retry of the same logical version.
    const artifactSubdirectory = `${pipelineId}/${version}-${randomBytes(4).toString("hex")}`;
    const rendered = await renderPipeline({
      spec,
      pipelineId,
      pipelineVersion: version,
      templateRoot: this.#templateRoot,
      artifactRoot: this.#artifactRoot,
      artifactSubdirectory,
    });
    const artifactManifest = await readFile(
      join(rendered.outputDirectory, "artifact-manifest.json"),
    );
    const configurationHash = `sha256:${createHash("sha256").update(artifactManifest).digest("hex")}`;
    const stopBlock = spec.startBlock + this.#validationBlockCount;
    if (!Number.isSafeInteger(stopBlock)) {
      throw new Error("Validation block range exceeds safe integer bounds");
    }
    await this.#store.enqueueBuild({
      pipelineId,
      version,
      artifactDirectory: rendered.outputDirectory,
      configurationHash,
      validationStartBlock: spec.startBlock,
      validationStopBlock: stopBlock,
    });
    const updated = await this.#store.getPipeline(pipelineId);
    if (updated === null) throw new Error("Pipeline disappeared after build queueing");
    return updated;
  }

  getPipeline(pipelineId: string): Promise<PipelineSnapshot | null> {
    return this.#store.getPipeline(pipelineId);
  }

  listPipelines(): Promise<PipelineSnapshot[]> {
    return this.#store.listPipelines();
  }
}

function addStructuredOverrides(prompt: string, overrides?: PlanOverrides): string {
  if (overrides === undefined) return prompt;
  const supplied: Record<string, unknown> = {};
  if (overrides.contracts !== undefined) supplied.contracts = overrides.contracts;
  if (overrides.startBlock !== undefined && overrides.startBlock !== null) {
    supplied.startBlock = overrides.startBlock;
  }
  if (Object.keys(supplied).length === 0) return prompt;
  return `${prompt}\n\nTrusted builder fields (these override prose): ${JSON.stringify(supplied)}`;
}

function applyStructuredOverrides(
  spec: PipelineSpec,
  overrides?: PlanOverrides,
): PipelineSpec {
  const overridden = {
    ...spec,
    ...(overrides?.contracts === undefined ? {} : { contracts: overrides.contracts }),
    ...(overrides?.startBlock === undefined || overrides.startBlock === null
      ? {}
      : { startBlock: overrides.startBlock }),
  };
  return normalizePipelineSpec(parsePipelineSpec(overridden));
}

export class StaticPipelinePlanner implements PipelinePlanner {
  constructor(readonly spec: PipelineSpec) {}

  async plan(): Promise<{ status: "ready"; spec: PipelineSpec }> {
    return { status: "ready", spec: this.spec };
  }
}
