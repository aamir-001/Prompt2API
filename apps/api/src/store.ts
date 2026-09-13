import type { PipelineSpec, PipelineState } from "@prompt2api/contracts";
import {
  PipelineRunStage,
  PipelineRunStatus,
  Prisma,
  PrismaClient,
} from "@prompt2api/db";
import { assertPipelineTransition } from "./state-machine.js";

export interface DerivedPlan {
  importedPackage: "ethereum-common@v0.3.3";
  modules: [
    "ethereum_common:filtered_events",
    "map_vault_events",
    "db_out",
  ];
  filterExpression: string;
  eventTopics: string[];
  schemaName: string;
}

export interface PipelineSnapshot {
  id: string;
  originalPrompt: string;
  state: PipelineState;
  spec: PipelineSpec | null;
  derivedPlan: DerivedPlan | null;
  slug: string | null;
  activeVersion: number;
  pricing: ApiProductPricing | null;
  contracts: Array<{ address: string; label: string | null }>;
  versions: Array<{
    version: number;
    templateVersion: string;
    importedPackageVersion: string;
    configurationHash: string | null;
    packageHash: string | null;
    artifactDirectory: string;
    validationStartBlock: number | null;
    validationStopBlock: number | null;
    validationResult: unknown;
  }>;
  runs: Array<{
    id: string;
    version: number;
    stage: string;
    status: string;
    attempt: number;
    exitCode: number | null;
    stdout: string | null;
    stderr: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    createdAt: Date;
  }>;
  transitions: Array<{
    fromState: PipelineState | null;
    toState: PipelineState;
    reason: string;
    createdAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiProductPricing {
  enabled: true;
  protocol: "x402";
  version: 2;
  network: "hedera:testnet";
  scheme: "exact";
  asset: "0.0.0";
  amount: string;
  unit: "tinybar";
  payTo: string;
  protectedResources: readonly ["events", "hourlyFlows"];
}

export interface EnqueueBuildInput {
  pipelineId: string;
  version: number;
  artifactDirectory: string;
  configurationHash: string;
  validationStartBlock: number;
  validationStopBlock: number;
}

export interface ClaimedBuildJob {
  runId: string;
  pipelineId: string;
  version: number;
}

export interface FinishRunInput {
  runId: string;
  status: "SUCCEEDED" | "FAILED" | "FAILED_INTERRUPTED" | "CANCELLED";
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ValidationArtifacts {
  pipelineId: string;
  version: number;
  packageHash: string;
  validationResult: unknown;
}

export interface DeploymentContext {
  id: string;
  pipelineId: string;
  version: number;
  schemaName: string;
  startBlock: number;
  processId: number | null;
  status: "STARTING" | "LIVE" | "STOPPED" | "FAILED";
  artifactDirectory: string;
}

export interface ControlStore {
  createPipeline(id: string, originalPrompt: string): Promise<PipelineSnapshot>;
  recordReadyPlan(
    pipelineId: string,
    spec: PipelineSpec,
    derivedPlan: DerivedPlan,
    slug: string,
  ): Promise<PipelineSnapshot>;
  updatePipelineSpec(pipelineId: string, spec: PipelineSpec): Promise<void>;
  transition(pipelineId: string, to: PipelineState, reason: string): Promise<void>;
  getPipeline(pipelineId: string): Promise<PipelineSnapshot | null>;
  listPipelines(): Promise<PipelineSnapshot[]>;
  enqueueBuild(input: EnqueueBuildInput): Promise<ClaimedBuildJob>;
  claimOldestBuild(): Promise<ClaimedBuildJob | null>;
  createStageRun(
    pipelineId: string,
    version: number,
    stage: "INFO" | "GRAPH" | "VALIDATION",
  ): Promise<string>;
  finishRun(input: FinishRunInput): Promise<void>;
  saveValidationArtifacts(input: ValidationArtifacts): Promise<void>;
  recoverInterruptedJobs(): Promise<number>;
  cancelPendingRuns(pipelineId: string): Promise<void>;
  getPipelineBySlug(slug: string): Promise<PipelineSnapshot | null>;
  upsertApiProduct(pipelineId: string, pricing: ApiProductPricing): Promise<void>;
  createDeployment(
    pipelineId: string,
    version: number,
    schemaName: string,
    startBlock: number,
  ): Promise<DeploymentContext>;
  markDeploymentLive(deploymentId: string, processId: number): Promise<void>;
  markDeploymentOutput(deploymentId: string): Promise<void>;
  markDeploymentStopped(
    deploymentId: string,
    status: "STOPPED" | "FAILED",
    lastError?: string,
  ): Promise<void>;
  listLiveDeployments(): Promise<DeploymentContext[]>;
}

const pipelineInclude = {
  apiProduct: true,
  contracts: { orderBy: { createdAt: "asc" as const } },
  versions: { orderBy: { version: "asc" as const } },
  runs: { orderBy: { createdAt: "asc" as const } },
  transitions: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.PipelineInclude;

type PipelineWithRelations = Prisma.PipelineGetPayload<{
  include: typeof pipelineInclude;
}>;

function snapshot(row: PipelineWithRelations): PipelineSnapshot {
  return {
    id: row.id,
    originalPrompt: row.originalPrompt,
    state: row.state,
    spec: row.spec as PipelineSpec | null,
    derivedPlan: row.derivedPlan as unknown as DerivedPlan | null,
    slug: row.slug,
    activeVersion: row.activeVersion,
    pricing: (row.apiProduct?.pricing as unknown as ApiProductPricing | null) ?? null,
    contracts: row.contracts.map(({ address, label }) => ({ address, label })),
    versions: row.versions.map((version) => ({
      version: version.version,
      templateVersion: version.templateVersion,
      importedPackageVersion: version.importedPackageVersion,
      configurationHash: version.configurationHash,
      packageHash: version.packageHash,
      artifactDirectory: version.artifactDirectory,
      validationStartBlock: version.validationStartBlock,
      validationStopBlock: version.validationStopBlock,
      validationResult: version.validationResult,
    })),
    runs: row.runs.map((run) => ({
      id: run.id,
      version: run.version,
      stage: run.stage,
      status: run.status,
      attempt: run.attempt,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      createdAt: run.createdAt,
    })),
    transitions: row.transitions.map((transition) => ({
      fromState: transition.fromState,
      toState: transition.toState,
      reason: transition.reason,
      createdAt: transition.createdAt,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaControlStore implements ControlStore {
  constructor(readonly prisma: PrismaClient) {}

  async createPipeline(id: string, originalPrompt: string): Promise<PipelineSnapshot> {
    const row = await this.prisma.pipeline.create({
      data: {
        id,
        originalPrompt,
        transitions: {
          create: { toState: "DRAFT", reason: "Pipeline created" },
        },
      },
      include: pipelineInclude,
    });
    return snapshot(row);
  }

  async recordReadyPlan(
    pipelineId: string,
    spec: PipelineSpec,
    derivedPlan: DerivedPlan,
    slug: string,
  ): Promise<PipelineSnapshot> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.pipeline.findUniqueOrThrow({
        where: { id: pipelineId },
        select: { state: true },
      });
      assertPipelineTransition(current.state, "PLAN_READY");
      const row = await transaction.pipeline.update({
        where: { id: pipelineId },
        data: {
          state: "PLAN_READY",
          spec: spec as Prisma.InputJsonValue,
          derivedPlan: derivedPlan as unknown as Prisma.InputJsonValue,
          slug,
          contracts: {
            deleteMany: {},
            create: spec.contracts.map(({ address, label }) => ({
              address: address.toLowerCase(),
              ...(label === undefined ? {} : { label }),
            })),
          },
          transitions: {
            create: {
              fromState: current.state,
              toState: "PLAN_READY",
              reason: "Validated pipeline plan is ready",
            },
          },
        },
        include: pipelineInclude,
      });
      return snapshot(row);
    });
  }

  async transition(
    pipelineId: string,
    to: PipelineState,
    reason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.pipeline.findUniqueOrThrow({
        where: { id: pipelineId },
        select: { state: true },
      });
      assertPipelineTransition(current.state, to);
      await transaction.pipeline.update({
        where: { id: pipelineId },
        data: {
          state: to,
          transitions: {
            create: { fromState: current.state, toState: to, reason },
          },
        },
      });
    });
  }

  async getPipeline(pipelineId: string): Promise<PipelineSnapshot | null> {
    const row = await this.prisma.pipeline.findUnique({
      where: { id: pipelineId },
      include: pipelineInclude,
    });
    return row === null ? null : snapshot(row);
  }

  async listPipelines(): Promise<PipelineSnapshot[]> {
    const rows = await this.prisma.pipeline.findMany({
      orderBy: { createdAt: "desc" },
      include: pipelineInclude,
    });
    return rows.map(snapshot);
  }

  async updatePipelineSpec(
    pipelineId: string,
    spec: PipelineSpec,
  ): Promise<void> {
    await this.prisma.pipeline.update({
      where: { id: pipelineId },
      data: { spec: spec as unknown as Prisma.InputJsonValue },
    });
  }

  async getPipelineBySlug(slug: string): Promise<PipelineSnapshot | null> {
    const row = await this.prisma.pipeline.findUnique({
      where: { slug },
      include: pipelineInclude,
    });
    return row === null ? null : snapshot(row);
  }

  async upsertApiProduct(
    pipelineId: string,
    pricing: ApiProductPricing,
  ): Promise<void> {
    await this.prisma.apiProduct.upsert({
      where: { pipelineId },
      create: {
        pipelineId,
        pricing: pricing as unknown as Prisma.InputJsonValue,
      },
      update: { pricing: pricing as unknown as Prisma.InputJsonValue },
    });
  }

  async enqueueBuild(input: EnqueueBuildInput): Promise<ClaimedBuildJob> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.pipeline.findUniqueOrThrow({
        where: { id: input.pipelineId },
        select: { state: true, activeVersion: true },
      });
      assertPipelineTransition(current.state, "BUILD_QUEUED");
      if (input.version !== current.activeVersion + 1) {
        throw new Error("Build version is stale");
      }
      const run = await transaction.pipelineRun.create({
        data: {
          pipelineId: input.pipelineId,
          version: input.version,
          stage: "BUILD",
          status: "PENDING",
        },
      });
      await transaction.pipeline.update({
        where: { id: input.pipelineId },
        data: {
          state: "BUILD_QUEUED",
          activeVersion: input.version,
          versions: {
            create: {
              version: input.version,
              templateVersion: "v1",
              importedPackageVersion: "ethereum-common@v0.3.3",
              configurationHash: input.configurationHash,
              artifactDirectory: input.artifactDirectory,
              validationStartBlock: input.validationStartBlock,
              validationStopBlock: input.validationStopBlock,
            },
          },
          transitions: {
            create: {
              fromState: current.state,
              toState: "BUILD_QUEUED",
              reason: `Build version ${input.version} queued`,
            },
          },
        },
      });
      return { runId: run.id, pipelineId: run.pipelineId, version: run.version };
    });
  }

  async claimOldestBuild(): Promise<ClaimedBuildJob | null> {
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<
        Array<{ id: string; pipelineId: string; version: number }>
      >(Prisma.sql`
        SELECT "id", "pipelineId", "version"
        FROM "pipeline_runs"
        WHERE "status" = 'PENDING'::"PipelineRunStatus"
          AND "stage" = 'BUILD'::"PipelineRunStage"
        ORDER BY "createdAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const row = rows[0];
      if (row === undefined) return null;
      await transaction.pipelineRun.update({
        where: { id: row.id },
        data: { status: "RUNNING", startedAt: new Date() },
      });
      return { runId: row.id, pipelineId: row.pipelineId, version: row.version };
    });
  }

  async createStageRun(
    pipelineId: string,
    version: number,
    stage: "INFO" | "GRAPH" | "VALIDATION",
  ): Promise<string> {
    const run = await this.prisma.pipelineRun.create({
      data: {
        pipelineId,
        version,
        stage: stage as PipelineRunStage,
        status: "RUNNING",
        startedAt: new Date(),
      },
    });
    return run.id;
  }

  async finishRun(input: FinishRunInput): Promise<void> {
    await this.prisma.pipelineRun.update({
      where: { id: input.runId },
      data: {
        status: input.status as PipelineRunStatus,
        endedAt: new Date(),
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        ...(input.stdout === undefined ? {} : { stdout: input.stdout }),
        ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.errorMessage === undefined
          ? {}
          : { errorMessage: input.errorMessage }),
      },
    });
  }

  async saveValidationArtifacts(input: ValidationArtifacts): Promise<void> {
    await this.prisma.pipelineVersion.update({
      where: {
        pipelineId_version: {
          pipelineId: input.pipelineId,
          version: input.version,
        },
      },
      data: {
        packageHash: input.packageHash,
        validationResult: input.validationResult as Prisma.InputJsonValue,
      },
    });
  }

  async recoverInterruptedJobs(): Promise<number> {
    return this.prisma.$transaction(async (transaction) => {
      const interrupted = await transaction.pipelineRun.updateMany({
        where: {
          status: "RUNNING",
          stage: { in: ["BUILD", "INFO", "GRAPH", "VALIDATION"] },
        },
        data: {
          status: "FAILED_INTERRUPTED",
          endedAt: new Date(),
          errorCode: "PROCESS_INTERRUPTED",
          errorMessage: "API process restarted while this job was running",
        },
      });
      const pipelines = await transaction.pipeline.findMany({
        where: { state: { in: ["BUILDING", "VALIDATING"] } },
        select: { id: true, state: true },
      });
      for (const pipeline of pipelines) {
        assertPipelineTransition(pipeline.state, "FAILED_INTERRUPTED");
        await transaction.pipeline.update({
          where: { id: pipeline.id },
          data: {
            state: "FAILED_INTERRUPTED",
            transitions: {
              create: {
                fromState: pipeline.state,
                toState: "FAILED_INTERRUPTED",
                reason: "API restarted during an active job",
              },
            },
          },
        });
      }
      return interrupted.count;
    });
  }

  async cancelPendingRuns(pipelineId: string): Promise<void> {
    await this.prisma.pipelineRun.updateMany({
      where: { pipelineId, status: "PENDING" },
      data: {
        status: "CANCELLED",
        endedAt: new Date(),
        errorCode: "CANCELLED",
        errorMessage: "Cancelled by operator",
      },
    });
  }

  async createDeployment(
    pipelineId: string,
    version: number,
    schemaName: string,
    startBlock: number,
  ): Promise<DeploymentContext> {
    const deployment = await this.prisma.deployment.create({
      data: { pipelineId, version, schemaName, startBlock, status: "STARTING" },
    });
    const pipelineVersion = await this.prisma.pipelineVersion.findUniqueOrThrow({
      where: { pipelineId_version: { pipelineId, version } },
      select: { artifactDirectory: true },
    });
    return { ...deployment, artifactDirectory: pipelineVersion.artifactDirectory };
  }

  async markDeploymentLive(deploymentId: string, processId: number): Promise<void> {
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "LIVE", processId, startedAt: new Date(), stoppedAt: null },
    });
  }

  async markDeploymentOutput(deploymentId: string): Promise<void> {
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { lastOutputAt: new Date() },
    });
  }

  async markDeploymentStopped(
    deploymentId: string,
    status: "STOPPED" | "FAILED",
    lastError?: string,
  ): Promise<void> {
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status,
        processId: null,
        stoppedAt: new Date(),
        ...(lastError === undefined ? {} : { lastError }),
      },
    });
  }

  async listLiveDeployments(): Promise<DeploymentContext[]> {
    const deployments = await this.prisma.deployment.findMany({
      where: { status: "LIVE" },
      orderBy: { createdAt: "asc" },
    });
    return Promise.all(
      deployments.map(async (deployment) => {
        const version = await this.prisma.pipelineVersion.findUniqueOrThrow({
          where: {
            pipelineId_version: {
              pipelineId: deployment.pipelineId,
              version: deployment.version,
            },
          },
          select: { artifactDirectory: true },
        });
        return { ...deployment, artifactDirectory: version.artifactDirectory };
      }),
    );
  }
}
