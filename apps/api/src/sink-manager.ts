import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { redactOutput } from "@indexloom/substreams-runner";
import type { ControlStore, DeploymentContext } from "./store.js";

export interface DatasetProvisioner {
  setupSchema(schemaName: string): Promise<void>;
}

export interface SinkManagerOptions {
  store: ControlStore;
  datasetProvisioner: DatasetProvisioner;
  artifactRoot: string;
  executable?: string;
  endpoint: string;
  apiToken: string;
  datasetDatabaseUrl: string;
  setupTimeoutMs: number;
  baseEnvironment?: NodeJS.ProcessEnv;
  spawnImplementation?: typeof spawn;
}

interface ManagedSink {
  deployment: DeploymentContext;
  child: ChildProcessWithoutNullStreams;
}

function sinkDsn(databaseUrl: string, schemaName: string): string {
  const parsed = new URL(databaseUrl);
  if (!/^dataset_pl_[a-z0-9]{8,32}$/.test(schemaName)) {
    throw new Error("Invalid dataset schema name");
  }
  if (parsed.protocol === "postgresql:") parsed.protocol = "psql:";
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "psql:") {
    throw new Error("Dataset database URL must use PostgreSQL");
  }
  if (
    ["localhost", "127.0.0.1", "host.docker.internal"].includes(parsed.hostname) &&
    !parsed.searchParams.has("sslmode")
  ) {
    parsed.searchParams.set("sslmode", "disable");
  }
  parsed.searchParams.set("schemaName", schemaName);
  return parsed.toString();
}

function sinkEnvironment(
  source: NodeJS.ProcessEnv,
  apiToken: string,
  dsn: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    SUBSTREAMS_API_TOKEN: apiToken,
    SUBSTREAMS_SINK_DSN: dsn,
  };
  for (const key of ["PATH", "Path", "RUSTUP_TOOLCHAIN", "CARGO_HOME", "RUSTUP_HOME"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

export class SinkManager {
  readonly #store: ControlStore;
  readonly #datasetProvisioner: DatasetProvisioner;
  readonly #artifactRoot: string;
  readonly #executable: string;
  readonly #endpoint: string;
  readonly #apiToken: string;
  readonly #datasetDatabaseUrl: string;
  readonly #setupTimeoutMs: number;
  readonly #baseEnvironment: NodeJS.ProcessEnv;
  readonly #spawn: typeof spawn;
  readonly #sinks = new Map<string, ManagedSink>();
  readonly #intentionalStops = new Set<string>();

  constructor(options: SinkManagerOptions) {
    this.#store = options.store;
    this.#datasetProvisioner = options.datasetProvisioner;
    this.#artifactRoot = resolve(options.artifactRoot);
    this.#executable = options.executable ?? "substreams";
    if (
      this.#executable !== "substreams" &&
      (!isAbsolute(this.#executable) || !/substreams(?:\.exe)?$/i.test(this.#executable))
    ) {
      throw new Error("Substreams executable is not allowlisted");
    }
    this.#endpoint = options.endpoint;
    this.#apiToken = options.apiToken;
    this.#datasetDatabaseUrl = options.datasetDatabaseUrl;
    this.#setupTimeoutMs = options.setupTimeoutMs;
    this.#baseEnvironment = options.baseEnvironment ?? process.env;
    this.#spawn = options.spawnImplementation ?? spawn;
  }

  async deploy(
    pipelineId: string,
    version: number,
    schemaName: string,
    startBlock: number,
  ): Promise<DeploymentContext> {
    await this.#datasetProvisioner.setupSchema(schemaName);
    const deployment = await this.#store.createDeployment(
      pipelineId,
      version,
      schemaName,
      startBlock,
    );
    try {
      await this.#runSetup(deployment);
      const child = await this.#spawnSink(deployment);
      if (child.pid === undefined) throw new Error("Sink process did not expose a PID");
      await this.#store.markDeploymentLive(deployment.id, child.pid);
      await this.#store.transition(pipelineId, "LIVE", "PostgreSQL sink started");
      return { ...deployment, status: "LIVE", processId: child.pid };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sink deployment failed";
      await this.#store.markDeploymentStopped(deployment.id, "FAILED", message);
      await this.#store.transition(pipelineId, "DEPLOYMENT_FAILED", message);
      throw error;
    }
  }

  async restartLiveDeployments(): Promise<number> {
    const deployments = await this.#store.listLiveDeployments();
    for (const deployment of deployments) {
      const child = await this.#spawnSink(deployment);
      if (child.pid === undefined) throw new Error("Sink process did not expose a PID");
      await this.#store.markDeploymentLive(deployment.id, child.pid);
    }
    return deployments.length;
  }

  async stop(deploymentId: string): Promise<boolean> {
    const managed = this.#sinks.get(deploymentId);
    if (managed === undefined) return false;
    this.#intentionalStops.add(deploymentId);
    managed.child.kill("SIGTERM");
    this.#sinks.delete(deploymentId);
    await this.#store.markDeploymentStopped(deploymentId, "STOPPED");
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#sinks.keys()].map((id) => this.stop(id)));
  }

  async #safeProjectDirectory(projectDirectory: string): Promise<string> {
    const [root, project] = await Promise.all([
      realpath(this.#artifactRoot),
      realpath(projectDirectory),
    ]);
    const fromRoot = relative(root, project);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error("Sink project directory is outside ARTIFACT_ROOT");
    }
    return project;
  }

  async #runSetup(deployment: DeploymentContext): Promise<void> {
    const cwd = await this.#safeProjectDirectory(deployment.artifactDirectory);
    const packageArgument = await this.#packageArgument(cwd);
    const dsn = sinkDsn(this.#datasetDatabaseUrl, deployment.schemaName);
    const child = this.#spawn(
      this.#executable,
      [
        "sink",
        "postgres",
        "setup",
        packageArgument,
      ],
      {
        cwd,
        env: sinkEnvironment(this.#baseEnvironment, this.#apiToken, dsn),
        shell: false,
        windowsHide: true,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += redactOutput(chunk.toString("utf8"), [this.#apiToken, dsn]);
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), this.#setupTimeoutMs);
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    }).finally(() => clearTimeout(timer));
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Substreams sink setup exited with ${String(exitCode)}`);
    }
  }

  async #spawnSink(
    deployment: DeploymentContext,
  ): Promise<ChildProcessWithoutNullStreams> {
    const cwd = await this.#safeProjectDirectory(deployment.artifactDirectory);
    const packageArgument = await this.#packageArgument(cwd);
    const dsn = sinkDsn(this.#datasetDatabaseUrl, deployment.schemaName);
    const child = this.#spawn(
      this.#executable,
      [
        "sink",
        "postgres",
        packageArgument,
        "-e",
        this.#endpoint,
        "-s",
        String(deployment.startBlock),
        "--batch-block-flush-interval",
        "1",
      ],
      {
        cwd,
        env: sinkEnvironment(this.#baseEnvironment, this.#apiToken, dsn),
        shell: false,
        windowsHide: true,
      },
    );
    const managed = { deployment, child };
    this.#sinks.set(deployment.id, managed);
    const onOutput = (chunk: Buffer): void => {
      redactOutput(chunk.toString("utf8"), [this.#apiToken, dsn]);
      void this.#store.markDeploymentOutput(deployment.id);
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("close", (exitCode) => {
      this.#sinks.delete(deployment.id);
      if (this.#intentionalStops.delete(deployment.id)) return;
      const message = `PostgreSQL sink exited with code ${String(exitCode)}`;
      void this.#store.markDeploymentStopped(deployment.id, "FAILED", message);
      void this.#markPipelineFailed(deployment.pipelineId, message);
    });
    return child;
  }

  async #packageArgument(projectDirectory: string): Promise<string> {
    const packages = (await readdir(projectDirectory))
      .filter((name) => /^[a-z0-9][a-z0-9-]*-v\d+\.\d+\.\d+\.spkg$/.test(name))
      .sort();
    if (packages.length !== 1) {
      throw new Error(`Expected exactly one built Substreams package, found ${packages.length}`);
    }
    return `./${packages[0]!}`;
  }

  async #markPipelineFailed(pipelineId: string, reason: string): Promise<void> {
    const pipeline = await this.#store.getPipeline(pipelineId);
    if (pipeline?.state === "LIVE" || pipeline?.state === "DEPLOYING") {
      await this.#store.transition(pipelineId, "DEPLOYMENT_FAILED", reason);
    }
  }
}

export const sinkInternals = { sinkDsn, sinkEnvironment };
