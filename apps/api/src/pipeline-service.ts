import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PlannerResultSchema,
  type PipelinePlanner,
  type PipelineSpec,
} from "@indexloom/contracts";
import { renderPipeline } from "@indexloom/generator";
import { derivePipelineConfig } from "@indexloom/pipeline-config";
import type { ControlStore, DerivedPlan, PipelineSnapshot } from "./store.js";

const MAX_PROMPT_LENGTH = 4_000;

export interface PipelineServiceOptions {
  store: ControlStore;
  planner: PipelinePlanner;
  artifactRoot: string;
  templateRoot: string;
  validationBlockCount: number;
  createPipelineId?: () => string;
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

  async plan(prompt: string): Promise<PipelineSnapshot> {
    if (prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Prompt must contain 1-${MAX_PROMPT_LENGTH} characters`);
    }
    const pipelineId = this.#createPipelineId();
    await this.#store.createPipeline(pipelineId, prompt);
    await this.#store.transition(pipelineId, "PLANNING", "Planning started");

    try {
      const result = PlannerResultSchema.parse(await this.#planner.plan(prompt));
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
        const config = derivePipelineConfig(result.spec, { pipelineId });
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

  async queueBuild(pipelineId: string): Promise<PipelineSnapshot> {
    const pipeline = await this.#store.getPipeline(pipelineId);
    if (pipeline === null) throw new Error("Pipeline not found");
    if (pipeline.spec === null) throw new Error("Pipeline has no validated specification");
    const version = pipeline.activeVersion + 1;
    const artifactSubdirectory = `${pipelineId}/${version}`;
    const rendered = await renderPipeline({
      spec: pipeline.spec,
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
    const stopBlock = pipeline.spec.startBlock + this.#validationBlockCount;
    if (!Number.isSafeInteger(stopBlock)) {
      throw new Error("Validation block range exceeds safe integer bounds");
    }
    await this.#store.enqueueBuild({
      pipelineId,
      version,
      artifactDirectory: rendered.outputDirectory,
      configurationHash,
      validationStartBlock: pipeline.spec.startBlock,
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

export class StaticPipelinePlanner implements PipelinePlanner {
  constructor(readonly spec: PipelineSpec) {}

  async plan(): Promise<{ status: "ready"; spec: PipelineSpec }> {
    return { status: "ready", spec: this.spec };
  }
}
