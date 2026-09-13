import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export interface ProcessResult {
  commandLabel: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface ValidationOptions {
  projectDirectory: string;
  endpoint: string;
  startBlock: number;
  stopBlock: number;
  apiToken: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface ProjectCommandOptions {
  projectDirectory: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface SubstreamsRunnerOptions {
  artifactRoot: string;
  executable?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
  maxCaptureBytes?: number;
  spawnImplementation?: typeof spawn;
}

interface SpawnRequest extends ProjectCommandOptions {
  subcommand: "build" | "pack" | "info" | "graph" | "run";
  args: string[];
  secrets?: string[];
  extraEnvironment?: Record<string, string>;
}

interface SharedCargoCache {
  directory: string;
  binaryPath: string;
  fingerprint: string;
  stampPath: string;
}

const COMPILED_TEMPLATE_INPUTS = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "build.rs",
  "proto/prompt2api/erc4626/v1/vault.proto",
  "src/lib.rs",
  "src/abi/mod.rs",
  "abi/erc4626.json",
] as const;

const COMPILED_WASM_PATH = join(
  "wasm32-unknown-unknown",
  "release",
  "prompt2api_erc4626_template.wasm",
);

const OutputEventSchema = z.strictObject({
  eventId: z.string().min(1),
  chainId: z.literal("base-mainnet"),
  vaultAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  senderAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  ownerAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  receiverAddress: z.string().regex(/^0x[0-9a-f]{40}$/).optional(),
  assetsRaw: z.string().regex(/^\d+$/),
  sharesRaw: z.string().regex(/^\d+$/),
  blockNumber: z.string().regex(/^\d+$/),
  blockTime: z.iso.datetime({ offset: true }),
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  logIndex: z.number().int().nonnegative(),
});

const JsonlEnvelopeSchema = z.strictObject({
  "@module": z.literal("map_vault_events"),
  "@block": z.number().int().nonnegative(),
  "@type": z.literal("prompt2api.erc4626.v1.VaultEvents"),
  "@data": z.strictObject({
    deposits: z.array(OutputEventSchema).optional(),
    withdrawals: z.array(OutputEventSchema).optional(),
  }),
});

export type PreviewEvent = z.infer<typeof OutputEventSchema> & {
  eventType: "DEPOSIT" | "WITHDRAW";
};

export interface ValidationPreview {
  events: PreviewEvent[];
  sourceBlocks: number[];
}

function appendBounded(current: string, chunk: string, limit: number): string {
  if (Buffer.byteLength(current) >= limit) return current;
  const remaining = limit - Buffer.byteLength(current);
  return current + Buffer.from(chunk).subarray(0, remaining).toString("utf8");
}

export function redactOutput(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted
    .replace(/(?:postgres(?:ql)?|psql):\/\/[^\s"']+/gi, "[REDACTED_DSN]")
    .replace(/(?:authorization:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
}

function childEnvironment(
  source: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "RUSTUP_TOOLCHAIN", "CARGO_HOME", "RUSTUP_HOME"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return { ...environment, ...extra };
}

export class SubstreamsRunner {
  readonly #artifactRoot: string;
  readonly #executable: string;
  readonly #baseEnvironment: NodeJS.ProcessEnv;
  readonly #maxCaptureBytes: number;
  readonly #spawn: typeof spawn;

  constructor(options: SubstreamsRunnerOptions) {
    this.#artifactRoot = resolve(options.artifactRoot);
    this.#executable = options.executable ?? "substreams";
    if (
      this.#executable !== "substreams" &&
      (!isAbsolute(this.#executable) || !/substreams(?:\.exe)?$/i.test(this.#executable))
    ) {
      throw new Error("Substreams executable is not allowlisted");
    }
    this.#baseEnvironment = options.baseEnvironment ?? process.env;
    this.#maxCaptureBytes = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
    this.#spawn = options.spawnImplementation ?? spawn;
  }

  async build(options: ProjectCommandOptions): Promise<ProcessResult> {
    const sharedCargoCache = await this.#prepareSharedCargoCache(options.projectDirectory);
    const useCachedBinary = sharedCargoCache === undefined
      ? false
      : await this.#cacheMatches(sharedCargoCache);
    const result = await this.#run({
      ...options,
      subcommand: useCachedBinary ? "pack" : "build",
      args: useCachedBinary
        ? ["pack", "./substreams.yaml"]
        : ["build", "--manifest", "./substreams.yaml"],
      ...(sharedCargoCache === undefined
        ? {}
        : { extraEnvironment: { CARGO_TARGET_DIR: sharedCargoCache.directory } }),
    });
    if (
      !useCachedBinary &&
      sharedCargoCache !== undefined &&
      result.exitCode === 0 &&
      !result.timedOut &&
      !result.cancelled &&
      await this.#isFile(sharedCargoCache.binaryPath)
    ) {
      await writeFile(sharedCargoCache.stampPath, `${sharedCargoCache.fingerprint}\n`, "utf8");
    }
    return result;
  }

  async #prepareSharedCargoCache(projectDirectory: string): Promise<SharedCargoCache | undefined> {
    const project = await realpath(projectDirectory);
    const artifactRoot = await realpath(this.#artifactRoot);
    const fromRoot = relative(artifactRoot, project);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error("Project directory is outside ARTIFACT_ROOT");
    }

    const projectTarget = join(project, "target");
    const sharedTarget = join(artifactRoot, ".cargo-target");
    await mkdir(sharedTarget, { recursive: true });
    try {
      const targetStat = await lstat(projectTarget);
      if (!targetStat.isSymbolicLink()) return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const linkTarget = process.platform === "win32"
        ? sharedTarget
        : relative(project, sharedTarget);
      try {
        await symlink(linkTarget, projectTarget, process.platform === "win32" ? "junction" : "dir");
      } catch (symlinkError) {
        if ((symlinkError as NodeJS.ErrnoException).code !== "EEXIST") throw symlinkError;
      }
    }
    if ((await realpath(projectTarget)) !== (await realpath(sharedTarget))) {
      throw new Error("Project target symlink does not resolve to the shared Cargo cache");
    }
    const fingerprint = await this.#compilationFingerprint(project);
    return {
      directory: sharedTarget,
      binaryPath: join(sharedTarget, COMPILED_WASM_PATH),
      fingerprint,
      stampPath: join(sharedTarget, ".prompt2api-template-sha256"),
    };
  }

  async #compilationFingerprint(projectDirectory: string): Promise<string> {
    const hash = createHash("sha256");
    for (const input of COMPILED_TEMPLATE_INPUTS) {
      hash.update(input);
      hash.update("\0");
      hash.update(await readFile(join(projectDirectory, input)));
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  async #cacheMatches(cache: SharedCargoCache): Promise<boolean> {
    if (!await this.#isFile(cache.binaryPath)) return false;
    try {
      return (await readFile(cache.stampPath, "utf8")).trim() === cache.fingerprint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async #isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  info(options: ProjectCommandOptions): Promise<ProcessResult> {
    return this.#run({
      ...options,
      subcommand: "info",
      args: ["info", "./substreams.yaml"],
    });
  }

  graph(options: ProjectCommandOptions): Promise<ProcessResult> {
    return this.#run({
      ...options,
      subcommand: "graph",
      args: ["graph", "./substreams.yaml"],
    });
  }

  validate(options: ValidationOptions): Promise<ProcessResult> {
    if (!Number.isSafeInteger(options.startBlock) || options.startBlock < 0) {
      throw new Error("Invalid validation start block");
    }
    if (!Number.isSafeInteger(options.stopBlock) || options.stopBlock <= options.startBlock) {
      throw new Error("Invalid validation stop block");
    }
    if (!/^[a-z0-9.-]+:\d+$/i.test(options.endpoint)) {
      throw new Error("Invalid Substreams endpoint");
    }
    return this.#run({
      ...options,
      subcommand: "run",
      args: [
        "run",
        "-e",
        options.endpoint,
        "-s",
        String(options.startBlock),
        "-t",
        String(options.stopBlock),
        "./substreams.yaml",
        "map_vault_events",
        "-o",
        "jsonl",
      ],
      secrets: [options.apiToken],
      extraEnvironment: { SUBSTREAMS_API_TOKEN: options.apiToken },
    });
  }

  async #run(request: SpawnRequest): Promise<ProcessResult> {
    const projectDirectory = await realpath(request.projectDirectory);
    const artifactRoot = await realpath(this.#artifactRoot);
    const fromRoot = relative(artifactRoot, projectDirectory);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error("Project directory is outside ARTIFACT_ROOT");
    }

    const startedAt = Date.now();
    const secrets = request.secrets ?? [];
    const environment = childEnvironment(
      this.#baseEnvironment,
      request.extraEnvironment ?? {},
    );
    const child: ChildProcessWithoutNullStreams = this.#spawn(this.#executable, request.args, {
      cwd: projectDirectory,
      env: environment,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;

    const consume = (stream: "stdout" | "stderr", buffer: Buffer): void => {
      const sanitized = redactOutput(buffer.toString("utf8"), secrets);
      if (stream === "stdout") {
        stdout = appendBounded(stdout, sanitized, this.#maxCaptureBytes);
      } else {
        stderr = appendBounded(stderr, sanitized, this.#maxCaptureBytes);
      }
      request.onOutput?.(stream, sanitized);
    };
    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));

    const terminate = (): void => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    return new Promise((resolveResult, reject) => {
      child.once("error", (error) => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolveResult({
          commandLabel: `substreams ${request.subcommand}`,
          exitCode,
          signal,
          stdout,
          stderr,
          timedOut,
          cancelled,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

export function parseValidationJsonl(output: string): ValidationPreview {
  const events: PreviewEvent[] = [];
  const sourceBlocks: number[] = [];
  const eventIds = new Set<string>();

  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid validation JSONL at line ${index + 1}`, { cause: error });
    }
    const envelope = JsonlEnvelopeSchema.parse(parsed);
    sourceBlocks.push(envelope["@block"]);

    for (const [eventType, records] of [
      ["DEPOSIT", envelope["@data"].deposits ?? []],
      ["WITHDRAW", envelope["@data"].withdrawals ?? []],
    ] as const) {
      for (const event of records) {
        if (eventIds.has(event.eventId)) {
          throw new Error(`Duplicate validation event_id: ${event.eventId}`);
        }
        eventIds.add(event.eventId);
        events.push({ ...event, eventType });
      }
    }
  }

  return { events, sourceBlocks };
}
