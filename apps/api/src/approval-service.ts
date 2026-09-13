import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ApprovalRequestSchema,
  type ApprovalRequest,
} from "@prompt2api/contracts";
import { verifyRenderedPipeline } from "@prompt2api/generator";
import type { SinkManager } from "./sink-manager.js";
import type {
  ApiProductPricing,
  ControlStore,
  DeploymentContext,
} from "./store.js";

export class ArtifactChangedError extends Error {
  readonly code = "ARTIFACT_CHANGED";

  constructor(message = "The approved artifact no longer matches the preview") {
    super(message);
    this.name = "ArtifactChangedError";
  }
}

export class ApprovalService {
  constructor(
    readonly store: ControlStore,
    readonly sinkManager: Pick<SinkManager, "deploy">,
    readonly pricing?: ApiProductPricing,
  ) {}

  async approve(
    pipelineId: string,
    input: ApprovalRequest,
  ): Promise<DeploymentContext> {
    const approval = ApprovalRequestSchema.parse(input);
    const pipeline = await this.store.getPipeline(pipelineId);
    if (pipeline === null) throw new Error("Pipeline not found");
    if (
      pipeline.state !== "AWAITING_APPROVAL" &&
      pipeline.state !== "DEPLOYMENT_FAILED"
    ) {
      throw new Error(`Pipeline cannot be deployed from state: ${pipeline.state}`);
    }
    const version = pipeline.versions.find(
      (candidate) => candidate.version === pipeline.activeVersion,
    );
    if (
      version === undefined ||
      pipeline.spec === null ||
      pipeline.derivedPlan === null ||
      version.configurationHash === null ||
      version.packageHash === null
    ) {
      throw new Error("Pipeline approval artifacts are incomplete");
    }
    if (
      approval.configurationHash !== version.configurationHash ||
      approval.packageHash !== version.packageHash
    ) {
      throw new ArtifactChangedError();
    }

    const verification = await verifyRenderedPipeline(version.artifactDirectory);
    if (
      !verification.valid ||
      `sha256:${verification.manifestSha256}` !== version.configurationHash
    ) {
      throw new ArtifactChangedError(
        verification.errors.join("; ") || "Configuration hash changed",
      );
    }
    const packageFiles = (await readdir(version.artifactDirectory))
      .filter((name) => name.endsWith(".spkg"))
      .sort();
    if (packageFiles.length !== 1) {
      throw new ArtifactChangedError("Built package is missing or ambiguous");
    }
    const actualPackageHash = `sha256:${createHash("sha256")
      .update(await readFile(join(version.artifactDirectory, packageFiles[0]!)))
      .digest("hex")}`;
    if (actualPackageHash !== version.packageHash) {
      throw new ArtifactChangedError("Built package hash changed");
    }

    await this.store.transition(
      pipelineId,
      "DEPLOYING",
      `Approved configuration and package for version ${version.version}`,
    );
    const deployment = await this.sinkManager.deploy(
      pipelineId,
      version.version,
      pipeline.derivedPlan.schemaName,
      pipeline.spec.startBlock,
    );
    if (this.pricing !== undefined) {
      await this.store.upsertApiProduct(pipelineId, this.pricing);
    }
    return deployment;
  }
}
