import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { PipelinePlanner } from "@indexloom/contracts";
import { canPipelineTransition } from "./state-machine.js";
import type { BuildWorker } from "./build-worker.js";
import { PipelineService } from "./pipeline-service.js";
import type { ControlStore, PipelineSnapshot } from "./store.js";

const PlanRequestSchema = z.strictObject({
  prompt: z.string().min(1).max(4_000),
  overrides: z
    .strictObject({
      contracts: z.array(z.unknown()).max(3).optional(),
      startBlock: z.number().int().positive().safe().nullable().optional(),
    })
    .optional(),
});

export interface CreateAppOptions {
  store: ControlStore;
  planner: PipelinePlanner;
  worker: Pick<BuildWorker, "processNext" | "cancel">;
  artifactRoot: string;
  templateRoot: string;
  validationBlockCount: number;
  createPipelineId?: () => string;
}

function publicPipeline(pipeline: PipelineSnapshot): Record<string, unknown> {
  return {
    pipelineId: pipeline.id,
    status: pipeline.state,
    originalPrompt: pipeline.originalPrompt,
    spec: pipeline.spec,
    derivedPlan: pipeline.derivedPlan,
    slug: pipeline.slug,
    activeVersion: pipeline.activeVersion,
    contracts: pipeline.contracts,
    versions: pipeline.versions,
    transitions: pipeline.transitions,
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
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

  app.post("/v1/pipelines/plan", async (request, response, next) => {
    try {
      const body = PlanRequestSchema.parse(request.body);
      const pipeline = await service.plan(body.prompt);
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
        runs: pipeline.runs,
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

  app.post("/v1/pipelines/:pipelineId/approve", (_request, response) => {
    response.status(501).json({ error: { code: "APPROVAL_NOT_IMPLEMENTED" } });
  });

  app.get("/v1/pipelines", async (_request, response, next) => {
    try {
      response.json({ items: (await service.listPipelines()).map(publicPipeline) });
    } catch (error) {
      next(error);
    }
  });

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError) {
        response.status(400).json({
          error: { code: "INVALID_REQUEST", issues: error.issues },
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
