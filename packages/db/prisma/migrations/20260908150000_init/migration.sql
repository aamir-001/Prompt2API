CREATE TYPE "PipelineState" AS ENUM ('DRAFT', 'PLANNING', 'PLAN_READY', 'BUILD_QUEUED', 'BUILDING', 'VALIDATING', 'AWAITING_APPROVAL', 'DEPLOYING', 'LIVE', 'NEEDS_INPUT', 'UNSUPPORTED_SCOPE', 'PLAN_FAILED', 'BUILD_FAILED', 'VALIDATION_FAILED', 'FAILED_INTERRUPTED', 'DEPLOYMENT_FAILED', 'CANCELLED');
CREATE TYPE "PipelineRunStage" AS ENUM ('BUILD', 'INFO', 'GRAPH', 'VALIDATION', 'DEPLOYMENT', 'SINK');
CREATE TYPE "PipelineRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'FAILED_INTERRUPTED', 'CANCELLED');
CREATE TYPE "DeploymentStatus" AS ENUM ('STARTING', 'LIVE', 'STOPPED', 'FAILED');

CREATE TABLE "pipelines" (
    "id" VARCHAR(40) NOT NULL,
    "originalPrompt" TEXT NOT NULL,
    "state" "PipelineState" NOT NULL DEFAULT 'DRAFT',
    "spec" JSONB,
    "derivedPlan" JSONB,
    "slug" VARCHAR(80),
    "activeVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pipeline_contracts" (
    "id" TEXT NOT NULL,
    "pipelineId" VARCHAR(40) NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "label" VARCHAR(60),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pipeline_contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pipeline_versions" (
    "pipelineId" VARCHAR(40) NOT NULL,
    "version" INTEGER NOT NULL,
    "templateVersion" VARCHAR(20) NOT NULL,
    "importedPackageVersion" VARCHAR(40) NOT NULL,
    "configurationHash" VARCHAR(80),
    "packageHash" VARCHAR(80),
    "artifactDirectory" TEXT NOT NULL,
    "validationStartBlock" INTEGER,
    "validationStopBlock" INTEGER,
    "validationResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pipeline_versions_pkey" PRIMARY KEY ("pipelineId", "version")
);

CREATE TABLE "pipeline_runs" (
    "id" TEXT NOT NULL,
    "pipelineId" VARCHAR(40) NOT NULL,
    "version" INTEGER NOT NULL,
    "stage" "PipelineRunStage" NOT NULL,
    "status" "PipelineRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "exitCode" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(80),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "pipelineId" VARCHAR(40) NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaName" VARCHAR(63) NOT NULL,
    "startBlock" INTEGER NOT NULL,
    "processId" INTEGER,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'STARTING',
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "lastOutputAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pipeline_transitions" (
    "id" TEXT NOT NULL,
    "pipelineId" VARCHAR(40) NOT NULL,
    "fromState" "PipelineState",
    "toState" "PipelineState" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pipeline_transitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pipelines_slug_key" ON "pipelines"("slug");
CREATE INDEX "pipelines_state_createdAt_idx" ON "pipelines"("state", "createdAt");
CREATE UNIQUE INDEX "pipeline_contracts_pipelineId_address_key" ON "pipeline_contracts"("pipelineId", "address");
CREATE INDEX "pipeline_contracts_address_idx" ON "pipeline_contracts"("address");
CREATE INDEX "pipeline_runs_status_createdAt_idx" ON "pipeline_runs"("status", "createdAt");
CREATE INDEX "pipeline_runs_pipelineId_version_createdAt_idx" ON "pipeline_runs"("pipelineId", "version", "createdAt");
CREATE INDEX "deployments_status_idx" ON "deployments"("status");
CREATE INDEX "deployments_pipelineId_version_idx" ON "deployments"("pipelineId", "version");
CREATE INDEX "pipeline_transitions_pipelineId_createdAt_idx" ON "pipeline_transitions"("pipelineId", "createdAt");

ALTER TABLE "pipeline_contracts" ADD CONSTRAINT "pipeline_contracts_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
