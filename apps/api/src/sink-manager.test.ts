import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { PipelineSpec } from "@indexloom/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryControlStore } from "./memory-store.js";
import { SinkManager, sinkInternals } from "./sink-manager.js";
import type { DerivedPlan } from "./store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

function child(pid: number): ChildProcessWithoutNullStreams {
  const value = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(value, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdio: [],
    killed: false,
    kill: vi.fn(() => true),
  });
  return value;
}

describe("SinkManager", () => {
  it("sets up and starts the exact built package with isolated secrets", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "indexloom-sink-"));
    temporaryRoots.push(artifactRoot);
    const projectDirectory = join(artifactRoot, "pl_sink1234", "1");
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, "base-test-v0.1.0.spkg"), "package");
    const store = new MemoryControlStore();
    const spec: PipelineSpec = {
      version: 1,
      displayName: "Sink Test",
      chain: { id: "base-mainnet" },
      standard: "erc4626",
      contracts: [{ address: "0x050ce30b927da55177a4914ec73480238bad56f0" }],
      startBlock: 50_999_146,
      events: ["Deposit"],
      outputs: { rawEvents: true, hourlyFlows: true, topDepositors: false },
    };
    const derived: DerivedPlan = {
      importedPackage: "ethereum-common@v0.3.3",
      modules: [
        "ethereum_common:filtered_events",
        "map_vault_events",
        "db_out",
      ],
      filterExpression: "(evt_addr:test) &&\n(evt_sig:test)",
      eventTopics: ["0xtest"],
      schemaName: "dataset_pl_sink1234",
    };
    await store.createPipeline("pl_sink1234", "sink test");
    await store.transition("pl_sink1234", "PLANNING", "test");
    await store.recordReadyPlan("pl_sink1234", spec, derived, "sink-test-sink1234");
    await store.enqueueBuild({
      pipelineId: "pl_sink1234",
      version: 1,
      artifactDirectory: projectDirectory,
      configurationHash: `sha256:${"0".repeat(64)}`,
      validationStartBlock: 50_999_146,
      validationStopBlock: 50_999_246,
    });
    await store.transition("pl_sink1234", "BUILDING", "test");
    await store.transition("pl_sink1234", "VALIDATING", "test");
    await store.transition("pl_sink1234", "AWAITING_APPROVAL", "test");
    await store.transition("pl_sink1234", "DEPLOYING", "test");

    const setupChild = child(100);
    const sinkChild = child(4321);
    const spawnMock = vi
      .fn()
      .mockImplementationOnce(() => {
        queueMicrotask(() => setupChild.emit("close", 0, null));
        return setupChild;
      })
      .mockImplementationOnce(() => sinkChild);
    const setupSchema = vi.fn(async () => undefined);
    const manager = new SinkManager({
      store,
      datasetProvisioner: { setupSchema },
      artifactRoot,
      executable: "substreams",
      endpoint: "base-mainnet.streamingfast.io:443",
      apiToken: "graph-secret",
      datasetDatabaseUrl: "postgresql://user:password@localhost/indexloom",
      setupTimeoutMs: 1_000,
      baseEnvironment: {
        PATH: "safe-path",
        GEMINI_API_KEY: "must-not-leak",
      },
      spawnImplementation: spawnMock as unknown as typeof spawn,
    });

    const deployment = await manager.deploy(
      "pl_sink1234",
      1,
      "dataset_pl_sink1234",
      50_999_146,
    );
    expect(deployment.status).toBe("LIVE");
    expect(deployment.processId).toBe(4321);
    expect(setupSchema).toHaveBeenCalledWith("dataset_pl_sink1234");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      "sink",
      "postgres",
      "setup",
      "./base-test-v0.1.0.spkg",
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      "sink",
      "postgres",
      "./base-test-v0.1.0.spkg",
      "-e",
      "base-mainnet.streamingfast.io:443",
      "-s",
      "50999146",
      "--batch-block-flush-interval",
      "1",
    ]);
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[];
      const options = call[2] as { shell: boolean; env: NodeJS.ProcessEnv };
      expect(args).toContain("./base-test-v0.1.0.spkg");
      expect(args).not.toContain("--dsn");
      expect(options.shell).toBe(false);
      expect(options.env.GEMINI_API_KEY).toBeUndefined();
      expect(options.env.SUBSTREAMS_API_TOKEN).toBe("graph-secret");
      expect(options.env.SUBSTREAMS_SINK_DSN).toContain("schemaName=dataset_pl_sink1234");
    }
    expect((await store.getPipeline("pl_sink1234"))?.state).toBe("LIVE");
    const restartSpawn = vi.fn(() => child(5678));
    const restartedManager = new SinkManager({
      store,
      datasetProvisioner: { setupSchema },
      artifactRoot,
      endpoint: "base-mainnet.streamingfast.io:443",
      apiToken: "graph-secret",
      datasetDatabaseUrl: "postgresql://user:password@localhost/indexloom",
      setupTimeoutMs: 1_000,
      spawnImplementation: restartSpawn as unknown as typeof spawn,
    });
    expect(await restartedManager.restartLiveDeployments()).toBe(1);
    expect(restartSpawn).toHaveBeenCalledOnce();
    await restartedManager.stopAll();
    expect(await manager.stop(deployment.id)).toBe(true);
  });

  it("normalizes only PostgreSQL DSNs and validates schema names", () => {
    expect(
      sinkInternals.sinkDsn(
        "postgresql://user:password@localhost/indexloom",
        "dataset_pl_1234abcd",
      ),
    ).toBe(
      "psql://user:password@localhost/indexloom?sslmode=disable&schemaName=dataset_pl_1234abcd",
    );
    expect(
      sinkInternals.sinkDsn(
        "postgresql://user:password@db.example.com/indexloom?sslmode=require",
        "dataset_pl_1234abcd",
      ),
    ).toBe(
      "psql://user:password@db.example.com/indexloom?sslmode=require&schemaName=dataset_pl_1234abcd",
    );
    expect(() =>
      sinkInternals.sinkDsn("sqlite://local.db", "dataset_pl_1234abcd"),
    ).toThrow(/PostgreSQL/);
    expect(() =>
      sinkInternals.sinkDsn("postgresql://localhost/db", "public"),
    ).toThrow(/schema name/);
  });
});
