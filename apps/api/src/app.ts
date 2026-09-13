import { timingSafeEqual } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import {
  ApprovalRequestSchema,
  PipelineContractSchema,
  type PipelinePlanner,
} from "@prompt2api/contracts";
import type { DatasetService } from "@prompt2api/dataset-service";
import { PlannerResponseError, PlannerUnavailableError } from "@prompt2api/planner";
import { ArtifactChangedError, type ApprovalService } from "./approval-service.js";
import { canPipelineTransition } from "./state-machine.js";
import type { BuildWorker } from "./build-worker.js";
import { PipelineService } from "./pipeline-service.js";
import type { ControlStore, PipelineSnapshot } from "./store.js";
import type { DatasetPaymentGate } from "./payment.js";
import { NO_ACTIVITY_IN_SAMPLE } from "./validation-outcome.js";

const PlanRequestSchema = z.strictObject({
  prompt: z.string().min(1).max(4_000),
  overrides: z
    .strictObject({
      contracts: z.array(PipelineContractSchema).min(1).max(3).optional(),
      startBlock: z.number().int().nonnegative().safe().nullable().optional(),
    })
    .optional(),
});

const RetryRequestSchema = z.strictObject({
  startBlock: z.number().int().nonnegative().safe().optional(),
});

export interface CreateAppOptions {
  store: ControlStore;
  planner: PipelinePlanner;
  worker: Pick<BuildWorker, "processNext" | "cancel">;
  artifactRoot: string;
  templateRoot: string;
  validationBlockCount: number;
  approvalService: Pick<ApprovalService, "approve">;
  datasetService: Pick<
    DatasetService,
    "health" | "events" | "hourlyFlows" | "topDepositors"
  >;
  paymentGate?: DatasetPaymentGate | undefined;
  operatorToken?: string | undefined;
  allowLocalOperator?: boolean | undefined;
  createPipelineId?: () => string;
}

function publicPipeline(pipeline: PipelineSnapshot): Record<string, unknown> {
  const latestTransition = pipeline.transitions.at(-1);
  const activeVersion = pipeline.versions.find(
    ({ version }) => version === pipeline.activeVersion,
  );
  const hasNoActivity =
    pipeline.state === "VALIDATION_FAILED" &&
    latestTransition?.reason.startsWith(`${NO_ACTIVITY_IN_SAMPLE}:`) === true;
  return {
    pipelineId: pipeline.id,
    status: pipeline.state,
    originalPrompt: pipeline.originalPrompt,
    spec: pipeline.spec,
    derivedPlan: pipeline.derivedPlan,
    slug: pipeline.slug,
    activeVersion: pipeline.activeVersion,
    pricing: pipeline.pricing,
    contracts: pipeline.contracts,
    versions: pipeline.versions,
    transitions: pipeline.transitions,
    validationOutcome: hasNoActivity
      ? {
          status: NO_ACTIVITY_IN_SAMPLE,
          message: latestTransition!.reason.slice(NO_ACTIVITY_IN_SAMPLE.length + 1).trim(),
          startBlock: activeVersion?.validationStartBlock ?? null,
          stopBlock: activeVersion?.validationStopBlock ?? null,
        }
      : null,
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
  };
}

function publicRun(run: PipelineSnapshot["runs"][number]): Record<string, unknown> {
  const commandLabels: Record<string, string> = {
    BUILD: "substreams build/pack",
    INFO: "substreams info",
    GRAPH: "substreams graph",
    VALIDATION: "substreams run",
  };
  return {
    ...run,
    commandLabel: commandLabels[run.stage] ?? "trusted runner stage",
    durationMs: run.startedAt === null
      ? null
      : Math.max(0, (run.endedAt ?? new Date()).getTime() - run.startedAt.getTime()),
  };
}

export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  const service = new PipelineService({
    store: options.store,
    planner: options.planner,
    artifactRoot: options.artifactRoot,
    templateRoot: options.templateRoot,
    validationBlockCount: options.validationBlockCount,
    ...(options.createPipelineId === undefined
      ? {}
      : { createPipelineId: options.createPipelineId }),
  });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use("/v1/pipelines", (request, response, next) => {
    const configuredToken = options.operatorToken;
    if (configuredToken !== undefined) {
      if (matchesBearerToken(request.header("authorization"), configuredToken)) {
        next();
        return;
      }
    } else if (options.allowLocalOperator === true && isLoopback(request.socket.remoteAddress)) {
      next();
      return;
    }
    response.status(401).json({ error: { code: "OPERATOR_AUTH_REQUIRED" } });
  });

  app.post("/v1/pipelines/plan", async (request, response, next) => {
    try {
      const body = PlanRequestSchema.parse(request.body);
      const pipeline = await service.plan(body.prompt, body.overrides);
      response
        .status(pipeline.state === "UNSUPPORTED_SCOPE" ? 422 : 200)
        .json(publicPipeline(pipeline));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/pipelines/:pipelineId/build", async (request, response, next) => {
    try {
      const pipeline = await service.queueBuild(request.params.pipelineId);
      response.status(202).json({
        pipelineId: pipeline.id,
        status: pipeline.state,
        statusUrl: `/v1/pipelines/${pipeline.id}`,
      });
      void options.worker.processNext();
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/pipelines/:pipelineId", async (request, response, next) => {
    try {
      const pipeline = await service.getPipeline(request.params.pipelineId);
      if (pipeline === null) {
        response.status(404).json({ error: { code: "PIPELINE_NOT_FOUND" } });
        return;
      }
      response.json(publicPipeline(pipeline));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/pipelines/:pipelineId/logs", async (request, response, next) => {
    try {
      const pipeline = await service.getPipeline(request.params.pipelineId);
      if (pipeline === null) {
        response.status(404).json({ error: { code: "PIPELINE_NOT_FOUND" } });
        return;
      }
      response.json({
        pipelineId: pipeline.id,
        runs: pipeline.runs.map(publicRun),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/pipelines/:pipelineId/preview", async (request, response, next) => {
    try {
      const pipeline = await service.getPipeline(request.params.pipelineId);
      if (pipeline === null) {
        response.status(404).json({ error: { code: "PIPELINE_NOT_FOUND" } });
        return;
      }
      const activeVersion = pipeline.versions.find(
        ({ version }) => version === pipeline.activeVersion,
      );
      response.json({
        pipelineId: pipeline.id,
        status: pipeline.state,
        configurationHash: activeVersion?.configurationHash ?? null,
        packageHash: activeVersion?.packageHash ?? null,
        validation: activeVersion?.validationResult ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/pipelines/:pipelineId/cancel", async (request, response, next) => {
    try {
      const pipeline = await service.getPipeline(request.params.pipelineId);
      if (pipeline === null) {
        response.status(404).json({ error: { code: "PIPELINE_NOT_FOUND" } });
        return;
      }
      if (!canPipelineTransition(pipeline.state, "CANCELLED")) {
        response.status(409).json({ error: { code: "ILLEGAL_TRANSITION" } });
        return;
      }
      options.worker.cancel(pipeline.id);
      await options.store.cancelPendingRuns(pipeline.id);
      await options.store.transition(pipeline.id, "CANCELLED", "Cancelled by operator");
      response.json({ pipelineId: pipeline.id, status: "CANCELLED" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/pipelines/:pipelineId/retry", async (request, response, next) => {
    try {
      const retry = RetryRequestSchema.parse(request.body ?? {});
      const pipeline = await service.queueBuild(request.params.pipelineId, retry);
      response.status(202).json({
        pipelineId: pipeline.id,
        status: pipeline.state,
        statusUrl: `/v1/pipelines/${pipeline.id}`,
      });
      void options.worker.processNext();
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/pipelines/:pipelineId/approve", async (request, response, next) => {
    try {
      const approval = ApprovalRequestSchema.parse(request.body);
      const deployment = await options.approvalService.approve(
        request.params.pipelineId,
        approval,
      );
      response.status(202).json({
        pipelineId: deployment.pipelineId,
        version: deployment.version,
        deploymentId: deployment.id,
        status: deployment.status,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/pipelines", async (_request, response, next) => {
    try {
      response.json({ items: (await service.listPipelines()).map(publicPipeline) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/datasets/:slug/meta", async (request, response, next) => {
    try {
      const pipeline = await requireDataset(options.store, request.params.slug);
      const indexedThroughBlock = await indexedBlock(
        options.datasetService,
        pipeline.derivedPlan!.schemaName,
      );
      response.json({
        dataset: pipeline.slug,
        version: pipeline.activeVersion,
        status:
          pipeline.state === "LIVE" && indexedThroughBlock !== null ? "LIVE" : "SYNCING",
        indexedThroughBlock,
        amountUnit: "raw",
        chain: "base-mainnet",
        standard: "erc4626",
        contracts: pipeline.contracts,
        events: pipeline.spec?.events ?? [],
        payment: options.paymentGate?.metadata ?? { enabled: false },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/datasets/:slug/schema", async (request, response, next) => {
    try {
      const pipeline = await requireDataset(options.store, request.params.slug);
      response.json({
        dataset: pipeline.slug,
        amountUnit: "raw",
        resources: {
          events: [
            "eventId",
            "chainId",
            "vaultAddress",
            "eventType",
            "senderAddress",
            "ownerAddress",
            "receiverAddress",
            "assetsRaw",
            "sharesRaw",
            "blockNumber",
            "blockTime",
            "transactionHash",
            "logIndex",
          ],
          hourlyFlows: [
            "vaultAddress",
            "hourStart",
            "inflowAssetsRaw",
            "outflowAssetsRaw",
            "netAssetsRaw",
            "depositCount",
            "withdrawalCount",
            "uniqueOwners",
          ],
          topDepositors: ["ownerAddress", "depositedAssetsRaw", "depositCount"],
        },
        access: {
          free: ["meta", "schema", "health"],
          paid: options.paymentGate?.metadata.protectedResources ?? [],
        },
        payment: options.paymentGate?.metadata ?? { enabled: false },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/datasets/:slug/health", async (request, response, next) => {
    try {
      const pipeline = await requireDataset(options.store, request.params.slug);
      const indexedThroughBlock = await indexedBlock(
        options.datasetService,
        pipeline.derivedPlan!.schemaName,
      );
      response.json({
        dataset: pipeline.slug,
        status:
          pipeline.state === "LIVE" && indexedThroughBlock !== null ? "LIVE" : "SYNCING",
        indexedThroughBlock,
      });
    } catch (error) {
      next(error);
    }
  });

  for (const [route, method, paid] of [
    ["/v1/datasets/:slug/events", "events", true],
    ["/v1/datasets/:slug/flows/hourly", "hourlyFlows", true],
    ["/v1/datasets/:slug/top-depositors", "topDepositors", false],
  ] as const) {
    const handlers: RequestHandler[] = [];
    if (paid && options.paymentGate !== undefined) {
      handlers.push(async (request, response, next) => {
        try {
          response.locals.liveDataset = await requireLiveDataset(
            options.store,
            options.datasetService,
            requiredRouteParam(request.params.slug, "slug"),
          );
          next();
        } catch (error) {
          next(error);
        }
      });
      handlers.push(options.paymentGate.middleware);
    }
    handlers.push(async (request, response, next) => {
      try {
        const pipeline = (response.locals.liveDataset as
          | Awaited<ReturnType<typeof requireLiveDataset>>
          | undefined) ?? await requireLiveDataset(
            options.store,
            options.datasetService,
            requiredRouteParam(request.params.slug, "slug"),
          );
        const page = await options.datasetService[method](
          pipeline.derivedPlan!.schemaName,
          request.query,
        );
        response.json({
          dataset: pipeline.slug,
          version: pipeline.activeVersion,
          status: "LIVE",
          indexedThroughBlock: pipeline.indexedThroughBlock,
          amountUnit: "raw",
          ...page,
        });
      } catch (error) {
        next(error);
      }
    });
    app.get(route, ...handlers);
  }

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError) {
        response.status(400).json({
          error: { code: "INVALID_REQUEST", issues: error.issues },
        });
        return;
      }
      if (error instanceof ArtifactChangedError) {
        response.status(409).json({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof PlannerUnavailableError) {
        response.status(503).json({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof PlannerResponseError) {
        response.status(502).json({
          error: { code: "INVALID_PLANNER_RESPONSE", message: error.message },
        });
        return;
      }
      if (error instanceof DatasetSyncingError) {
        response.status(503).json({
          error: { code: "DATASET_SYNCING", message: error.message },
        });
        return;
      }
      const message = error instanceof Error ? error.message : "Internal error";
      const status = /not found/i.test(message) ? 404 : /Illegal pipeline transition/i.test(message) ? 409 : 500;
      response.status(status).json({
        error: {
          code: status === 404 ? "PIPELINE_NOT_FOUND" : status === 409 ? "ILLEGAL_TRANSITION" : "INTERNAL_ERROR",
          message,
        },
      });
    },
  );

  return app;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requiredRouteParam(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing route parameter: ${name}`);
  }
  return value;
}

function matchesBearerToken(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const actualBytes = Buffer.from(header.slice("Bearer ".length));
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

class DatasetSyncingError extends Error {}

async function requireDataset(
  store: ControlStore,
  slug: string,
): Promise<PipelineSnapshot> {
  const pipeline = await store.getPipelineBySlug(slug);
  if (pipeline === null || pipeline.derivedPlan === null) {
    throw new Error("Dataset not found");
  }
  return pipeline;
}

async function indexedBlock(
  datasetService: Pick<DatasetService, "health">,
  schemaName: string,
): Promise<string | null> {
  try {
    return (await datasetService.health(schemaName)).indexedThroughBlock;
  } catch {
    return null;
  }
}

async function requireLiveDataset(
  store: ControlStore,
  datasetService: Pick<DatasetService, "health">,
  slug: string,
): Promise<PipelineSnapshot & { indexedThroughBlock: string }> {
  const pipeline = await requireDataset(store, slug);
  const indexedThroughBlock = await indexedBlock(
    datasetService,
    pipeline.derivedPlan!.schemaName,
  );
  if (pipeline.state !== "LIVE" || indexedThroughBlock === null) {
    throw new DatasetSyncingError("Dataset sink has not produced a cursor yet");
  }
  return { ...pipeline, indexedThroughBlock };
}
