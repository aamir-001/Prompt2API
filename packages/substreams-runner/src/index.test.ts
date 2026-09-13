import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseValidationJsonl,
  redactOutput,
  SubstreamsRunner,
} from "./index.js";

const temporaryRoots: string[] = [];

const compiledTemplateInputs = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "build.rs",
  "proto/prompt2api/erc4626/v1/vault.proto",
  "src/lib.rs",
  "src/abi/mod.rs",
  "abi/erc4626.json",
] as const;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdout,
    stderr,
    stdin: new PassThrough(),
    stdio: [],
    killed: false,
    kill: vi.fn(() => true),
  });
  return { child, stdout, stderr };
}

async function writeCompiledTemplateInputs(projectDirectory: string): Promise<void> {
  for (const path of compiledTemplateInputs) {
    const destination = join(projectDirectory, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, `${path}\n`, "utf8");
  }
}

describe("SubstreamsRunner", () => {
  it("shares Cargo build artifacts across generated pipeline directories", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-runner-"));
    temporaryRoots.push(artifactRoot);
    const projectDirectory = join(artifactRoot, "pl_test1234", "1");
    await mkdir(projectDirectory, { recursive: true });
    await writeCompiledTemplateInputs(projectDirectory);
    const { child } = fakeChild();
    const spawnMock = vi.fn(() => child);
    const runner = new SubstreamsRunner({
      artifactRoot,
      spawnImplementation: spawnMock as unknown as typeof spawn,
    });

    const resultPromise = runner.build({ projectDirectory, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("close", 0, null);
    await resultPromise;

    expect((await lstat(join(projectDirectory, "target"))).isSymbolicLink()).toBe(true);
    expect(resolve(projectDirectory, await readlink(join(projectDirectory, "target"))))
      .toBe(join(artifactRoot, ".cargo-target"));
    const [, , spawnOptions] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(spawnOptions.env.CARGO_TARGET_DIR).toBe(join(artifactRoot, ".cargo-target"));
  });

  it("packs from a fingerprint-matched reviewed WASM cache", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-runner-"));
    temporaryRoots.push(artifactRoot);
    const projectDirectory = join(artifactRoot, "pl_test1234", "1");
    await mkdir(projectDirectory, { recursive: true });
    await writeCompiledTemplateInputs(projectDirectory);
    const first = fakeChild();
    const second = fakeChild();
    const spawnMock = vi.fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const runner = new SubstreamsRunner({
      artifactRoot,
      spawnImplementation: spawnMock as unknown as typeof spawn,
    });

    const firstBuild = runner.build({ projectDirectory, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const binaryPath = join(
      artifactRoot,
      ".cargo-target",
      "wasm32-unknown-unknown",
      "release",
      "prompt2api_erc4626_template.wasm",
    );
    await mkdir(join(binaryPath, ".."), { recursive: true });
    await writeFile(binaryPath, "reviewed wasm", "utf8");
    first.child.emit("close", 0, null);
    await firstBuild;

    const cachedBuild = runner.build({ projectDirectory, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    second.child.emit("close", 0, null);
    await cachedBuild;

    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      "build",
      "--manifest",
      "./substreams.yaml",
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(["pack", "./substreams.yaml"]);
  });

  it("uses argument arrays, shell false, a bounded environment, and redaction", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-runner-"));
    temporaryRoots.push(artifactRoot);
    const projectDirectory = join(artifactRoot, "pl_test1234", "1");
    await mkdir(projectDirectory, { recursive: true });
    const { child, stdout, stderr } = fakeChild();
    const spawnMock = vi.fn(() => child);
    const runner = new SubstreamsRunner({
      artifactRoot,
      executable: "substreams",
      baseEnvironment: {
        PATH: "safe-path",
        GEMINI_API_KEY: "must-not-leak",
        DATABASE_URL: "postgresql://user:password@localhost/db",
      },
      spawnImplementation: spawnMock as unknown as typeof spawn,
    });

    const resultPromise = runner.validate({
      projectDirectory,
      endpoint: "base-mainnet.streamingfast.io:443",
      startBlock: 100,
      stopBlock: 200,
      apiToken: "secret-token",
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    stdout.write("secret-token\n");
    stderr.write("postgresql://user:password@localhost/db\n");
    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean; cwd: string; env: NodeJS.ProcessEnv },
    ];
    expect(command).toBe("substreams");
    expect(args[0]).toBe("run");
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(projectDirectory);
    expect(options.env.GEMINI_API_KEY).toBeUndefined();
    expect(options.env.DATABASE_URL).toBeUndefined();
    expect(options.env.SUBSTREAMS_API_TOKEN).toBe("secret-token");
    expect(result.stdout).toBe("[REDACTED]\n");
    expect(result.stderr).toBe("[REDACTED_DSN]\n");
  });

  it("redacts explicit secrets and database URLs", () => {
    expect(
      redactOutput(
        "token postgres://user:pass@db.example/prompt2api",
        ["token"],
      ),
    ).toBe("[REDACTED] [REDACTED_DSN]");
  });

  it("terminates a process when its wall-clock timeout expires", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "prompt2api-runner-"));
    temporaryRoots.push(artifactRoot);
    const projectDirectory = join(artifactRoot, "pl_test1234", "1");
    await mkdir(projectDirectory, { recursive: true });
    await writeCompiledTemplateInputs(projectDirectory);
    const { child } = fakeChild();
    const kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    Object.defineProperty(child, "kill", { value: kill });
    const runner = new SubstreamsRunner({
      artifactRoot,
      spawnImplementation: vi.fn(() => child) as unknown as typeof spawn,
    });

    const result = await runner.build({
      projectDirectory,
      timeoutMs: 5,
    });
    expect(kill).toHaveBeenCalledOnce();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});

describe("parseValidationJsonl", () => {
  const line = JSON.stringify({
    "@module": "map_vault_events",
    "@block": 50_999_150,
    "@type": "prompt2api.erc4626.v1.VaultEvents",
    "@data": {
      deposits: [
        {
          eventId: "base-mainnet:0xa88efc19760e12e3773270f004ede724b58d9a82d7cef2dd0d9adf811a275095:12",
          chainId: "base-mainnet",
          vaultAddress: "0x050ce30b927da55177a4914ec73480238bad56f0",
          senderAddress: "0x3af0490e309a701ef5ab55cd017b74f2e192e8c0",
          ownerAddress: "0x3af0490e309a701ef5ab55cd017b74f2e192e8c0",
          assetsRaw: "523694647",
          sharesRaw: "503316024132450944623",
          blockNumber: "50999150",
          blockTime: "2026-09-07T13:27:27Z",
          transactionHash: "0xa88efc19760e12e3773270f004ede724b58d9a82d7cef2dd0d9adf811a275095",
          logIndex: 12,
        },
      ],
    },
  });

  it("flattens typed event lists into preview records", () => {
    const result = parseValidationJsonl(`${line}\n`);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventType).toBe("DEPOSIT");
    expect(result.sourceBlocks).toEqual([50_999_150]);
  });

  it("rejects malformed and duplicate output", () => {
    expect(() => parseValidationJsonl("not-json")).toThrow(/line 1/);
    expect(() => parseValidationJsonl(`${line}\n${line}\n`)).toThrow(/Duplicate/);
  });
});
