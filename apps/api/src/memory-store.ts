import type { PipelineSpec, PipelineState } from "@indexloom/contracts";
import { randomUUID } from "node:crypto";
import { assertPipelineTransition } from "./state-machine.js";
import type {
  ClaimedBuildJob,
  ControlStore,
  DerivedPlan,
  EnqueueBuildInput,
  FinishRunInput,
  PipelineSnapshot,
  ValidationArtifacts,
  DeploymentContext,
} from "./store.js";

export class MemoryControlStore implements ControlStore {
  readonly #pipelines = new Map<string, PipelineSnapshot>();
  readonly #deployments = new Map<string, DeploymentContext>();

  async createPipeline(id: string, originalPrompt: string): Promise<PipelineSnapshot> {
    const now = new Date();
    const pipeline: PipelineSnapshot = {
      id,
      originalPrompt,
      state: "DRAFT",
      spec: null,
      derivedPlan: null,
      slug: null,
      activeVersion: 0,
      contracts: [],
      versions: [],
      runs: [],
      transitions: [
        {
          fromState: null,
          toState: "DRAFT",
          reason: "Pipeline created",
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    this.#pipelines.set(id, pipeline);
    return structuredClone(pipeline);
  }

  async recordReadyPlan(
    pipelineId: string,
    spec: PipelineSpec,
    derivedPlan: DerivedPlan,
    slug: string,
  ): Promise<PipelineSnapshot> {
    const pipeline = this.#required(pipelineId);
    this.#transition(pipeline, "PLAN_READY", "Validated pipeline plan is ready");
    pipeline.spec = structuredClone(spec);
    pipeline.derivedPlan = structuredClone(derivedPlan);
    pipeline.slug = slug;
    pipeline.contracts = spec.contracts.map(({ address, label }) => ({
      address: address.toLowerCase(),
      label: label ?? null,
    }));
    return structuredClone(pipeline);
  }

  async transition(
    pipelineId: string,
    to: PipelineState,
    reason: string,
  ): Promise<void> {
    this.#transition(this.#required(pipelineId), to, reason);
  }

  async getPipeline(pipelineId: string): Promise<PipelineSnapshot | null> {
    const pipeline = this.#pipelines.get(pipelineId);
    return pipeline === undefined ? null : structuredClone(pipeline);
  }

  async listPipelines(): Promise<PipelineSnapshot[]> {
    return [...this.#pipelines.values()]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((pipeline) => structuredClone(pipeline));
  }

  async getPipelineBySlug(slug: string): Promise<PipelineSnapshot | null> {
    const pipeline = [...this.#pipelines.values()].find(
      (candidate) => candidate.slug === slug,
    );
    return pipeline === undefined ? null : structuredClone(pipeline);
  }

  async enqueueBuild(input: EnqueueBuildInput): Promise<ClaimedBuildJob> {
    const pipeline = this.#required(input.pipelineId);
    if (input.version !== pipeline.activeVersion + 1) {
      throw new Error("Build version is stale");
    }
    this.#transition(
      pipeline,
      "BUILD_QUEUED",
      `Build version ${input.version} queued`,
    );
    pipeline.activeVersion = input.version;
    pipeline.versions.push({
      version: input.version,
      templateVersion: "v1",
      importedPackageVersion: "ethereum-common@v0.3.3",
      configurationHash: input.configurationHash,
      packageHash: null,
      artifactDirectory: input.artifactDirectory,
      validationStartBlock: input.validationStartBlock,
      validationStopBlock: input.validationStopBlock,
      validationResult: null,
    });
    const runId = randomUUID();
    pipeline.runs.push({
      id: runId,
      version: input.version,
      stage: "BUILD",
      status: "PENDING",
      attempt: 1,
      exitCode: null,
      stdout: null,
      stderr: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
    });
    return { runId, pipelineId: input.pipelineId, version: input.version };
  }

  async claimOldestBuild(): Promise<ClaimedBuildJob | null> {
    const candidates = [...this.#pipelines.values()]
      .flatMap((pipeline) =>
        pipeline.runs.map((run) => ({ pipeline, run })),
      )
      .filter(({ run }) => run.stage === "BUILD" && run.status === "PENDING")
      .sort(
        (left, right) =>
          left.run.createdAt.getTime() - right.run.createdAt.getTime() ||
          left.run.id.localeCompare(right.run.id),
      );
    const candidate = candidates[0];
    if (candidate === undefined) return null;
    candidate.run.status = "RUNNING";
    return {
      runId: candidate.run.id,
      pipelineId: candidate.pipeline.id,
      version: candidate.run.version,
    };
  }

  async createStageRun(
    pipelineId: string,
    version: number,
    stage: "INFO" | "GRAPH" | "VALIDATION",
  ): Promise<string> {
    const runId = randomUUID();
    this.#required(pipelineId).runs.push({
      id: runId,
      version,
      stage,
      status: "RUNNING",
      attempt: 1,
      exitCode: null,
      stdout: null,
      stderr: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
    });
    return runId;
  }

  async finishRun(input: FinishRunInput): Promise<void> {
    const run = [...this.#pipelines.values()]
      .flatMap(({ runs }) => runs)
      .find(({ id }) => id === input.runId);
    if (run === undefined) throw new Error(`Run not found: ${input.runId}`);
    run.status = input.status;
    run.exitCode = input.exitCode ?? null;
    run.stdout = input.stdout ?? null;
    run.stderr = input.stderr ?? null;
    run.errorCode = input.errorCode ?? null;
    run.errorMessage = input.errorMessage ?? null;
  }

  async saveValidationArtifacts(input: ValidationArtifacts): Promise<void> {
    const version = this.#required(input.pipelineId).versions.find(
      (candidate) => candidate.version === input.version,
    );
    if (version === undefined) throw new Error("Pipeline version not found");
    version.packageHash = input.packageHash;
    version.validationResult = structuredClone(input.validationResult);
  }

  async recoverInterruptedJobs(): Promise<number> {
    let count = 0;
    for (const pipeline of this.#pipelines.values()) {
      for (const run of pipeline.runs) {
        if (run.status === "RUNNING") {
          run.status = "FAILED_INTERRUPTED";
          run.errorCode = "PROCESS_INTERRUPTED";
          run.errorMessage = "API process restarted while this job was running";
          count += 1;
        }
      }
      if (pipeline.state === "BUILDING" || pipeline.state === "VALIDATING") {
        this.#transition(
          pipeline,
          "FAILED_INTERRUPTED",
          "API restarted during an active job",
        );
      }
    }
    return count;
  }

  async cancelPendingRuns(pipelineId: string): Promise<void> {
    for (const run of this.#required(pipelineId).runs) {
      if (run.status === "PENDING") {
        run.status = "CANCELLED";
        run.errorCode = "CANCELLED";
        run.errorMessage = "Cancelled by operator";
      }
    }
  }

  async createDeployment(
    pipelineId: string,
    version: number,
    schemaName: string,
    startBlock: number,
  ): Promise<DeploymentContext> {
    const pipeline = this.#required(pipelineId);
    const pipelineVersion = pipeline.versions.find(
      (candidate) => candidate.version === version,
    );
    if (pipelineVersion === undefined) throw new Error("Pipeline version not found");
    const deployment: DeploymentContext = {
      id: randomUUID(),
      pipelineId,
      version,
      schemaName,
      startBlock,
      processId: null,
      status: "STARTING",
      artifactDirectory: pipelineVersion.artifactDirectory,
    };
    this.#deployments.set(deployment.id, deployment);
    return structuredClone(deployment);
  }

  async markDeploymentLive(deploymentId: string, processId: number): Promise<void> {
    const deployment = this.#requiredDeployment(deploymentId);
    deployment.status = "LIVE";
    deployment.processId = processId;
  }

  async markDeploymentOutput(_deploymentId: string): Promise<void> {}

  async markDeploymentStopped(
    deploymentId: string,
    status: "STOPPED" | "FAILED",
  ): Promise<void> {
    const deployment = this.#requiredDeployment(deploymentId);
    deployment.status = status;
    deployment.processId = null;
  }

  async listLiveDeployments(): Promise<DeploymentContext[]> {
    return [...this.#deployments.values()]
      .filter(({ status }) => status === "LIVE")
      .map((deployment) => structuredClone(deployment));
  }

  #required(pipelineId: string): PipelineSnapshot {
    const pipeline = this.#pipelines.get(pipelineId);
    if (pipeline === undefined) throw new Error(`Pipeline not found: ${pipelineId}`);
    return pipeline;
  }

  #requiredDeployment(deploymentId: string): DeploymentContext {
    const deployment = this.#deployments.get(deploymentId);
    if (deployment === undefined) {
      throw new Error(`Deployment not found: ${deploymentId}`);
    }
    return deployment;
  }

  #transition(
    pipeline: PipelineSnapshot,
    toState: PipelineState,
    reason: string,
  ): void {
    assertPipelineTransition(pipeline.state, toState);
    const fromState = pipeline.state;
    pipeline.state = toState;
    pipeline.updatedAt = new Date();
    pipeline.transitions.push({
      fromState,
      toState,
      reason,
      createdAt: new Date(),
    });
  }
}
