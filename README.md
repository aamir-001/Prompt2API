# Prompt2API

**AI-powered factory for creating live, reusable blockchain data APIs.**

Prompt2API turns one supported natural-language request into a validated, inspectable, continuously synchronized data API:

> Prompt → strict plan → composed Substreams package → live Base validation → human approval → PostgreSQL sink → typed REST API

Phase 1 intentionally supports one excellent vertical slice: standard ERC-4626 `Deposit` and `Withdraw` datasets on Base mainnet for one to three explicitly supplied vaults. Requests outside that boundary are rejected rather than approximated. Phase 2 wraps the raw-event and hourly-flow APIs with x402 v2 payments on Hedera testnet.

## Problem and approach

Turning EVM logs into a dependable API normally requires contract-specific decoding, an indexing runtime, database design, deployment, cursor recovery, and an access-control layer. Prompt2API packages that workflow into one inspectable path. Gemini interprets intent, strict backend code validates and derives configuration, The Graph executes the Substreams package over historical and live Base data, PostgreSQL serves a stable schema, and x402 meters selected data routes without changing the underlying pipeline.

## Why this qualifies

- **The Graph is load-bearing.** The generated package validates against and continuously streams live Base data from a Graph Market Substreams provider.
- **The pipeline is composable.** It imports the pinned `ethereum-common@v0.3.3` package and consumes its indexed `filtered_events` module instead of reimplementing Base block extraction.
- **The output is standardized.** One safely grouped filter can select multiple ERC-4626 vaults, while every match enters the same `prompt2api.erc4626.v1.VaultEvent` model and API shape. Adding a second vault changes validated parameters, not Rust, Protobuf, or SQL.
- **AI is used safely.** Gemini produces only a strict `PipelineSpec`; reviewed TypeScript derives filters and configuration, and reviewed Rust/SQL templates do the executable work.

The separate payer agent validates payment terms before signing and never exposes its Hedera private key to the API or browser. See [docs/phase-2-x402.md](docs/phase-2-x402.md).

## Architecture

```mermaid
flowchart LR
    UI[Next.js builder] --> API[Express control API]
    API --> GEM[Gemini structured planner]
    GEM --> VALIDATE[Zod + viem validation]
    VALIDATE --> RENDER[Trusted template renderer]
    RENDER --> CLI[Constrained Substreams CLI runner]
    CLI --> GRAPH[The Graph Base provider]
    GRAPH --> PREVIEW[Live validation preview]
    PREVIEW --> APPROVE[Hash-bound approval]
    APPROVE --> SINK[Substreams PostgreSQL sink]
    SINK --> DATA[(Normalized events + SQL views)]
    DATA --> REST[Typed dataset REST API]
    REST --> X402[x402 resource server]
    X402 -->|402 requirements| AGENT[Restricted Hedera payer agent]
    AGENT --> BLOCKY[Blocky402 facilitator]
    BLOCKY --> HEDERA[Hedera testnet settlement]
    X402 -->|Paid data + receipt| UI
```

The model cannot select packages, dependencies, paths, commands, SQL, Rust, provider endpoints, credentials, or event topics. No unvalidated model output is passed to a command or child process. See [docs/architecture.md](docs/architecture.md) for the trust boundaries and runtime details.

Gemini has exactly three visible outcomes:

| Planner result | UI behavior |
| --- | --- |
| `ready` | Shows the complete validated `PipelineSpec` before any build can start. |
| `needs_clarification` | Shows the focused missing-information questions and returns the user to the builder. |
| `unsupported` | Explains that the request is outside the Base/ERC-4626 boundary; no substitute plan is invented. |

## Pinned toolchain

| Component | Version |
| --- | --- |
| Node.js | 22+ |
| pnpm | 10.34.5 |
| Next.js | 16.3.4 |
| React | 19.2.8 |
| TypeScript | 7.0.2 |
| Google Gen AI SDK | 2.21.0 |
| Gemini model | `gemini-3-flash-preview` |
| Prisma | 6.19.3 |
| Substreams CLI | 1.22.0 |
| Rust | 1.88.0 |
| `ethereum-common` | 0.3.3 |
| PostgreSQL | 17 tested |
| x402 packages | 2.25.0 |

The included dev container pins the Substreams/Rust environment and connects to host PostgreSQL through `host.docker.internal`.

## Prerequisites and credentials

1. Docker Desktop and VS Code with Dev Containers, or the pinned tools above installed directly.
2. PostgreSQL with two empty databases: `prompt2api` and `prompt2api_datasets`.
3. A Gemini API key from Google AI Studio.
4. A Substreams API token from The Graph Market with **Substreams & Firehose** enabled.
5. For paid-request testing, a funded Hedera testnet ECDSA account. Its key belongs only in `apps/consumer-agent/.env`.

Never commit `.env`. It is ignored by Git, and all Gemini requests stay in the backend.

## Fresh-clone setup

Open the repository in its dev container, then create the local environment file:

```bash
cp .env.example .env
```

Fill `.env` with your local values. From the dev container, local Windows PostgreSQL commonly uses:

```dotenv
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@host.docker.internal:5432/prompt2api?sslmode=disable
DATASET_DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@host.docker.internal:5432/prompt2api_datasets?sslmode=disable
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
SUBSTREAMS_API_TOKEN=YOUR_SUBSTREAMS_TOKEN
# Optional for loopback-only development; required for production.
OPERATOR_API_TOKEN=YOUR_32_PLUS_CHARACTER_OPERATOR_TOKEN
X402_ENABLED=true
X402_PAY_TO=0.0.YOUR_RECIPIENT_ACCOUNT
```

Keep the supplied planner configuration unchanged for Phase 1:

```dotenv
LLM_PROVIDER=google
LLM_MODEL=gemini-3-flash-preview
LLM_TIMEOUT_MS=30000
PLANNER_PROMPT_VERSION=v1
```

Then install dependencies, generate the Prisma client, and apply the control-plane migrations:

```bash
pnpm install --frozen-lockfile
pnpm --filter @prompt2api/db prisma:generate
pnpm --filter @prompt2api/db prisma:migrate
```

Start the API and web app in separate terminals:

```bash
pnpm --filter @prompt2api/api dev
pnpm --filter @prompt2api/web dev
```

Open `http://localhost:3000` and use the example prompt. The API listens on `http://localhost:4000`; Next.js proxies browser requests through `/control` so backend credentials are never exposed to client JavaScript.

To exercise a paid route, copy `apps/consumer-agent/.env.example` to `apps/consumer-agent/.env`, add the payer credentials, and run:

```bash
pnpm --filter @prompt2api/consumer-agent dev -- <dataset-slug> events
```

For the local visual demo, open a live dataset and click **Pay 0.001 HBAR & load data**. The browser asks for confirmation, starts the restricted payer subprocess through a server-only route, renders the purchased rows, and shows the Hedera settlement on HashScan. Every click creates a new testnet payment; there is no automatic paid refresh. The payer key remains only in `apps/consumer-agent/.env`.

Development servers bind to loopback by default. In production, configure the same `OPERATOR_API_TOKEN` for the API and web server, then unlock the browser session at `/operator`. The server stores only an HttpOnly session digest in the browser; it does not expose the configured token to client code.

## Golden request

```text
Track Deposit and Withdraw events for ERC-4626 vault
0x050ce30b927da55177a4914ec73480238bad56f0 on Base starting at
block 50999146. Normalize the events and expose raw records and hourly net flows.
```

Known validation ranges and expected transaction hashes are checked into `fixtures/`. The judge-inspectable generated package is in `generated/golden-erc4626/`.

A successful live provider response containing zero matches is reported as `NO_ACTIVITY_IN_SAMPLE`, not as a generic provider failure. The workspace explains that no matching events occurred in the fixed 100-block sample and lets the operator enter another start block and retry without calling Gemini again.

Two-vault composition uses the same reviewed mapper and schema:

```text
Track Deposit and Withdraw events for ERC-4626 vaults
0x050ce30b927da55177a4914ec73480238bad56f0 and
0xbeeff2490feffa212fac2f6553682c219e6a8845 on Base starting at block 50999146.
Expose raw events and hourly flows.
```

The backend derives a grouped `(vault A OR vault B) AND (Deposit OR Withdraw)` filter. Tests assert both addresses are present and that the composed manifest still consumes `ethereum_common:filtered_events` and emits the same normalized `VaultEvents` Protobuf type.

## API surface

Control workflow:

```text
POST /v1/pipelines/plan
POST /v1/pipelines/:pipelineId/build
GET  /v1/pipelines/:pipelineId
GET  /v1/pipelines/:pipelineId/logs
GET  /v1/pipelines/:pipelineId/preview
POST /v1/pipelines/:pipelineId/approve
POST /v1/pipelines/:pipelineId/cancel
POST /v1/pipelines/:pipelineId/retry
GET  /v1/pipelines
```

For `NO_ACTIVITY_IN_SAMPLE`, retry accepts `{ "startBlock": 50999200 }`. The value is parsed as a non-negative safe integer, written into the next validated `PipelineSpec`, and used to derive another fixed 100-block range.

Deployed datasets:

```text
GET /v1/datasets/:slug/meta
GET /v1/datasets/:slug/schema
GET /v1/datasets/:slug/health
GET /v1/datasets/:slug/events
GET /v1/datasets/:slug/flows/hourly
GET /v1/datasets/:slug/top-depositors
```

`meta`, `schema`, and `health` are free. `events` and `flows/hourly` require the configured Hedera x402 payment. Requirements use `PAYMENT-REQUIRED`; a successful paid response includes `PAYMENT-RESPONSE`.

Event queries support `vault`, `eventType`, `owner`, ISO-8601 `from`/`to`, `limit` up to 500, and opaque cursor pagination. Amounts are raw unsigned integer strings.

## Verification

The default suite is quota-free and uses mocked planners/processes:

```bash
pnpm typecheck
pnpm build
pnpm test
```

PostgreSQL integrations are opt-in. This command loads the ignored root `.env` without printing it:

```bash
pnpm test:database
```

The single live Gemini test is opt-in and makes one planning request:

```bash
pnpm test:live:gemini
```

The live Substreams golden test builds the manual package and validates a known 100-block Base range:

```bash
pnpm test:live:substreams
```

The real Hedera payment check is separately opt-in and spends the configured testnet amount once:

```bash
RUN_LIVE_X402_TEST=1 pnpm --filter @prompt2api/consumer-agent test:live -- <dataset-slug>
```

The manual feasibility evidence is documented in [spike/erc4626-manual/README.md](spike/erc4626-manual/README.md). The recorded 100-block smoke range returned 20 deposits and 7 withdrawals, and the PostgreSQL cursor-resume check produced no duplicate primary keys.

## Demo

The timed 2–4 minute recording script and safety checklist are in [docs/demo.md](docs/demo.md).

## Documentation and public artifacts

- [AI usage and structured planner outcomes](docs/AI_USAGE.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [End-to-end component ownership](docs/end-to-end-flow.md)
- [Hedera x402 design and recorded settlement](docs/phase-2-x402.md)
- [Reviewed ERC-4626 template](templates/erc4626/)
- [Generated golden package](generated/golden-erc4626/)
- [Implementation specification](ETHOnline-Implementation-Specification.md)
- [Official The Graph Substreams overview](https://thegraph.com/docs/en/substreams/overview/)
- [Official Substreams composition guide](https://docs.substreams.dev/how-to-guides/composing-substreams)
- [Official The Graph Market provider guide](https://thegraph.com/docs/en/substreams/providers/the-graph-market/)
- [x402 protocol documentation](https://docs.x402.org/introduction)
- [Blocky402 facilitator documentation](https://blocky402.com/)

## Repository map

```text
apps/web                 Next.js Create, Plan/Build, and Dataset screens
apps/api                 Express control API, worker, approval, sink manager
apps/consumer-agent      Restricted Hedera x402 payer and live test
packages/planner         Gemini provider adapter and backend response validation
packages/contracts       Strict Zod contracts and workflow states
packages/pipeline-config Deterministic topics, filters, slugs, and identifiers
packages/generator       Allowlisted trusted-template renderer
packages/substreams-runner Non-shell CLI execution and live-output parser
packages/dataset-service Parameterized PostgreSQL queries and pagination
packages/db              Prisma control-plane schema and migration
templates/erc4626        Reviewed reusable Rust/Protobuf/SQL package
generated/golden-erc4626 Judge-inspectable deterministic output
fixtures                 Known Base vaults, ranges, and event evidence
```

## Security properties

- Unknown keys and malformed planner values are rejected.
- Only Base, ERC-4626, one to three addresses, `Deposit`/`Withdraw`, and non-negative safe start blocks are accepted.
- SDK automatic retries are disabled; Prompt2API performs one retry only for timeout, rate-limit, or temporary provider failures.
- Quota exhaustion returns `503 PLANNER_UNAVAILABLE`; no default plan is invented.
- Generated files come from an allowlist, and approval re-hashes both source artifacts and the `.spkg`.
- Child processes use argument arrays with `shell: false`, bounded output, timeouts, cancellation, a restricted environment, and secret redaction.
- Builds run in a restricted subprocess, not an OS/container sandbox; arbitrary source execution remains explicitly out of scope.
- No unvalidated model output is passed to a command or child process.
- Gemini receives no Graph token or database DSN. Build processes receive no project secrets.
- Dataset SQL is parameterized, identifiers are backend-derived, and cursors are opaque.
- Payer requirements are allowlisted before signing; the API and browser never receive the Hedera private key.

## Current status

Phase 1 and the Phase 2 x402/Hedera path are implemented. Live Gemini, Substreams, PostgreSQL, and Hedera checks remain opt-in so ordinary development consumes neither model quota nor testnet HBAR.
