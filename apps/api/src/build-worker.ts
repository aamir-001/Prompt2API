import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineState } from "@indexloom/contracts";
import {
  parseValidationJsonl,
  type ProcessResult,
  type SubstreamsRunner,
} from "@indexloom/substreams-runner";
import type { ControlStore, PipelineSnapshot } from "./store.js";

export interface BuildWorkerOptions {
  store: ControlStore;
  runner: Pick<SubstreamsRunner, "build" | "info" | "graph" | "validate">;
  endpoint: string;
  apiToken: string;
  buildTimeoutMs: number;
  validationTimeoutMs: number;
  pollIntervalMs?: number;
}

export class BuildWorker {
  readonly #store: ControlStore;
  readonly #runner: BuildWorkerOptions["runner"];
  readonly #endpoint: string;
  readonly #apiToken: string;
  readonly #buildTimeoutMs: number;
  readonly #validationTimeoutMs: number;
  readonly #pollIntervalMs: number;
  #processing = false;
  #timer: NodeJS.Timeout | undefined;
  #activeAbort: AbortController | undefined;
  #activePipelineId: string | undefined;

  constructor(options: BuildWorkerOptions) {
    this.#store = options.store;
    this.#runner = options.runner;
    this.#endpoint = options.endpoint;
    this.#apiToken = options.apiToken;
    this.#buildTimeoutMs = options.buildTimeoutMs;
    this.#validationTimeoutMs = options.validationTimeoutMs;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  async start(): Promise<void> {
    await this.#store.recoverInterruptedJobs();
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.processNext(), this.#pollIntervalMs);
    this.#timer.unref();
    void this.processNext();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#activeAbort?.abort();
  }

  cancel(pipelineId: string): boolean {
    if (this.#activePipelineId !== pipelineId) return false;
    this.#activeAbort?.abort();
    return true;
  }

  async processNext(): Promise<boolean> {
    if (this.#processing) return false;
    this.#processing = true;
    try {
      const job = await this.#store.claimOldestBuild();
      if (job === null) return false;
      this.#activeAbort = new AbortController();
      this.#activePipelineId = job.pipelineId;
      await this.#execute(job.runId, job.pipelineId, job.version, this.#activeAbort.signal);
      return true;
    } finally {
      this.#activeAbort = undefined;
      this.#activePipelineId = undefined;
      this.#processing = false;
    }
  }

  async #execute(
    buildRunId: string,
    pipelineId: string,
    versionNumber: number,
    signal: AbortSignal,
  ): Promise<void> {
    let pipeline = await this.#requiredPipeline(pipelineId);
    const version = pipeline.versions.find(({ version }) => version === versionNumber);
    if (version === undefined) throw new Error("Claimed build has no pipeline version");
    const projectDirectory = version.artifactDirectory;

    try {
      await this.#store.transition(pipelineId, "BUILDING", "Build worker claimed job");
      await this.#runProcess(buildRunId, "BUILD_FAILED", () =>
        this.#runner.build({
          projectDirectory,
          timeoutMs: this.#buildTimeoutMs,
          signal,
        }),
      );

      await this.#runInspectionStage(
        pipelineId,
        versionNumber,
        "INFO",
        () =>
          this.#runner.info({
            projectDirectory,
            timeoutMs: this.#buildTimeoutMs,
            signal,
          }),
      );
      await this.#runInspectionStage(
        pipelineId,
        versionNumber,
        "GRAPH",
        () =>
          this.#runner.graph({
            projectDirectory,
            timeoutMs: this.#buildTimeoutMs,
            signal,
          }),
      );

      await this.#store.transition(
        pipelineId,
        "VALIDATING",
        "Package built and inspected successfully",
      );
      pipeline = await this.#requiredPipeline(pipelineId);
      const currentVersion = pipeline.versions.find(
        ({ version }) => version === versionNumber,
      );
      if (
        currentVersion?.validationStartBlock === null ||
        currentVersion?.validationStartBlock === undefined ||
        currentVersion.validationStopBlock === null
      ) {
        throw new Error("Validation range is missing");
      }

      const validationRunId = await this.#store.createStageRun(
        pipelineId,
        versionNumber,
        "VALIDATION",
      );
      const validationResult = await this.#runProcess(
        validationRunId,
        "VALIDATION_FAILED",
        () =>
          this.#runner.validate({
            projectDirectory,
            endpoint: this.#endpoint,
            startBlock: currentVersion.validationStartBlock!,
            stopBlock: currentVersion.validationStopBlock!,
            apiToken: this.#apiToken,
            timeoutMs: this.#validationTimeoutMs,
            signal,
          }),
      );
      const preview = parseValidationJsonl(validationResult.stdout);
      this.#validatePreview(preview.events, pipeline);
      await writeFile(
        join(projectDirectory, "validation-output.jsonl"),
        validationResult.stdout,
      );
      const packagePath = await this.#findPackage(projectDirectory);
      const packageHash = `sha256:${createHash("sha256")
        .update(await readFile(packagePath))
        .digest("hex")}`;
      await this.#store.saveValidationArtifacts({
        pipelineId,
        version: versionNumber,
        packageHash,
        validationResult: {
          eventCount: preview.events.length,
          preview: preview.events.slice(0, 50),
          sourceBlocks: preview.sourceBlocks,
          checklist: {
            hasEvents: true,
            uniqueEventIds: true,
            allowlistedVaultsOnly: true,
            validEventTypes: true,
            unsignedRawAmounts: true,
            requiredMetadataPresent: true,
          },
        },
      });
      await this.#store.transition(
        pipelineId,
        "AWAITING_APPROVAL",
        `Validated ${preview.events.length} live events`,
      );
    } catch (error) {
      const current = await this.#store.getPipeline(pipelineId);
      if (current !== null) {
        const failedState = this.#failureState(current.state);
        if (failedState !== null) {
          await this.#store.transition(
            pipelineId,
            failedState,
            error instanceof Error ? error.message : "Build worker failed",
          );
        }
      }
    }
  }

  async #runInspectionStage(
    pipelineId: string,
    version: number,
    stage: "INFO" | "GRAPH",
    run: () => Promise<ProcessResult>,
  ): Promise<void> {
    const runId = await this.#store.createStageRun(pipelineId, version, stage);
    await this.#runProcess(runId, "BUILD_FAILED", run);
  }

  async #runProcess(
    runId: string,
    defaultErrorCode: string,
    run: () => Promise<ProcessResult>,
  ): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await run();
    } catch (error) {
      await this.#store.finishRun({
        runId,
        status: "FAILED",
        errorCode: "PROCESS_START_FAILED",
        errorMessage: error instanceof Error ? error.message : "Process failed to start",
      });
      throw error;
    }
    await this.#finishProcessRun(runId, result, defaultErrorCode);
    return result;
  }

  async #finishProcessRun(
    runId: string,
    result: ProcessResult,
    defaultErrorCode: string,
  ): Promise<void> {
    const succeeded =
      result.exitCode === 0 && !result.timedOut && !result.cancelled;
    await this.#store.finishRun({
      runId,
      status: succeeded ? "SUCCEEDED" : result.cancelled ? "CANCELLED" : "FAILED",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(succeeded
        ? {}
        : {
            errorCode: result.timedOut
              ? "PROCESS_TIMEOUT"
              : result.cancelled
                ? "CANCELLED"
                : defaultErrorCode,
            errorMessage:
              result.stderr.trim() ||
              `${result.commandLabel} exited with code ${String(result.exitCode)}`,
          }),
    });
    if (!succeeded) {
      throw new Error(
        result.timedOut
          ? `${result.commandLabel} timed out`
          : result.cancelled
            ? `${result.commandLabel} was cancelled`
            : `${result.commandLabel} failed`,
      );
    }
  }

  #validatePreview(
    events: ReturnType<typeof parseValidationJsonl>["events"],
    pipeline: PipelineSnapshot,
  ): void {
    if (events.length === 0) throw new Error("Live validation returned no events");
    const allowedVaults = new Set(
      pipeline.contracts.map(({ address }) => address.toLowerCase()),
    );
    for (const event of events) {
      if (!allowedVaults.has(event.vaultAddress)) {
        throw new Error(`Validation returned an unconfigured vault: ${event.vaultAddress}`);
      }
      if (event.eventType === "WITHDRAW" && event.receiverAddress === undefined) {
        throw new Error("Withdraw validation record is missing receiverAddress");
      }
    }
  }

  async #findPackage(projectDirectory: string): Promise<string> {
    const candidates = (await readdir(projectDirectory))
      .filter((name) => name.endsWith(".spkg"))
      .sort();
    if (candidates.length !== 1) {
      throw new Error(`Expected one built .spkg, found ${candidates.length}`);
    }
    return join(projectDirectory, candidates[0]!);
  }

  async #requiredPipeline(pipelineId: string): Promise<PipelineSnapshot> {
    const pipeline = await this.#store.getPipeline(pipelineId);
    if (pipeline === null) throw new Error("Pipeline not found");
    return pipeline;
  }

  #failureState(state: PipelineState): PipelineState | null {
    if (state === "BUILDING") return "BUILD_FAILED";
    if (state === "VALIDATING") return "VALIDATION_FAILED";
    return null;
  }
}
