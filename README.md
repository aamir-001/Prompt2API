# IndexLoom

**AI-powered factory for creating live, reusable blockchain data APIs.**

IndexLoom turns one supported natural-language request into a validated, inspectable, continuously synchronized data API:

> Prompt → strict plan → composed Substreams package → live Base validation → human approval → PostgreSQL sink → typed REST API

Phase 1 intentionally supports one excellent vertical slice: standard ERC-4626 `Deposit` and `Withdraw` datasets on Base mainnet for one to three explicitly supplied vaults. Requests outside that boundary are rejected rather than approximated.

## Why this qualifies

- **The Graph is load-bearing.** The generated package validates against and continuously streams live Base data from a Graph Market Substreams provider.
- **The pipeline is composable.** It imports the pinned `ethereum-common@v0.3.3` package and consumes its indexed `filtered_events` module.
- **The output is standardized.** Multiple ERC-4626 vaults share one normalized event model and one API shape.
- **AI is used safely.** Gemini produces only a strict `PipelineSpec`; reviewed TypeScript derives filters and configuration, and reviewed Rust/SQL templates do the executable work.

No x402 or Hedera code is included in Phase 1. That boundary is documented in [docs/phase-2-x402.md](docs/phase-2-x402.md).

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
    REST --> UI
```

The model cannot select packages, dependencies, paths, commands, SQL, Rust, provider endpoints, credentials, or event topics. See [docs/architecture.md](docs/architecture.md) for the trust boundaries and runtime details.

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

The included dev container pins the Substreams/Rust environment and connects to host PostgreSQL through `host.docker.internal`.

## Prerequisites and credentials

1. Docker Desktop and VS Code with Dev Containers, or the pinned tools above installed directly.
2. PostgreSQL with two empty databases: `indexloom` and `indexloom_datasets`.
3. A Gemini API key from Google AI Studio.
4. A Substreams API token from The Graph Market with **Substreams & Firehose** enabled.

Never commit `.env`. It is ignored by Git, and all Gemini requests stay in the backend.

## Fresh-clone setup

Open the repository in its dev container, then create the local environment file:

```bash
cp .env.example .env
```

Fill `.env` with your local values. From the dev container, local Windows PostgreSQL commonly uses:

```dotenv
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@host.docker.internal:5432/indexloom?sslmode=disable
DATASET_DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@host.docker.internal:5432/indexloom_datasets?sslmode=disable
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
SUBSTREAMS_API_TOKEN=YOUR_SUBSTREAMS_TOKEN
# Optional for loopback-only development; required for production.
OPERATOR_API_TOKEN=YOUR_32_PLUS_CHARACTER_OPERATOR_TOKEN
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
pnpm --filter @indexloom/db prisma:generate
pnpm --filter @indexloom/db prisma:migrate
```

Start the API and web app in separate terminals:

```bash
pnpm --filter @indexloom/api dev
pnpm --filter @indexloom/web dev
```

Open `http://localhost:3000` and use the example prompt. The API listens on `http://localhost:4000`; Next.js proxies browser requests through `/control` so backend credentials are never exposed to client JavaScript.

Development servers bind to loopback by default. In production, configure the same `OPERATOR_API_TOKEN` for the API and web server, then unlock the browser session at `/operator`. The server stores only an HttpOnly session digest in the browser; it does not expose the configured token to client code.

## Golden request

```text
Track Deposit and Withdraw events for ERC-4626 vault
0x050ce30b927da55177a4914ec73480238bad56f0 on Base starting at
block 50999146. Normalize the events and expose raw records and hourly net flows.
```

Known validation ranges and expected transaction hashes are checked into `fixtures/`. The judge-inspectable generated package is in `generated/golden-erc4626/`.

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

Deployed datasets:

```text
GET /v1/datasets/:slug/meta
GET /v1/datasets/:slug/schema
GET /v1/datasets/:slug/health
GET /v1/datasets/:slug/events
GET /v1/datasets/:slug/flows/hourly
GET /v1/datasets/:slug/top-depositors
```

Event queries support `vault`, `eventType`, `owner`, ISO-8601 `from`/`to`, `limit` up to 500, and opaque cursor pagination. Amounts are raw unsigned integer strings.

## Verification

The default suite is quota-free and uses mocked planners/processes:

```bash
pnpm typecheck
pnpm build
pnpm test
```

PostgreSQL integrations are opt-in:

```bash
RUN_DATABASE_INTEGRATION=1 pnpm test
```

The single live Gemini test is opt-in and makes one planning request:

```bash
RUN_LIVE_GEMINI_TEST=1 pnpm exec vitest run packages/planner/src/planner.live.test.ts
```

The live Substreams golden test builds the manual package and validates a known 100-block Base range:

```bash
RUN_LIVE_SUBSTREAMS_TEST=1 pnpm exec vitest run packages/substreams-runner/src/live-golden.integration.test.ts
```

The manual feasibility evidence is documented in [spike/erc4626-manual/README.md](spike/erc4626-manual/README.md). The recorded 100-block smoke range returned 20 deposits and 7 withdrawals, and the PostgreSQL cursor-resume check produced no duplicate primary keys.

## Demo

The timed 2–4 minute recording script and safety checklist are in [docs/demo.md](docs/demo.md).

## Repository map

```text
apps/web                 Next.js Create, Plan/Build, and Dataset screens
apps/api                 Express control API, worker, approval, sink manager
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
- SDK automatic retries are disabled; IndexLoom performs one retry only for timeout, rate-limit, or temporary provider failures.
- Quota exhaustion returns `503 PLANNER_UNAVAILABLE`; no default plan is invented.
- Generated files come from an allowlist, and approval re-hashes both source artifacts and the `.spkg`.
- Child processes use argument arrays with `shell: false`, bounded output, timeouts, cancellation, a restricted environment, and secret redaction.
- Gemini receives no Graph token or database DSN. Build processes receive no project secrets.
- Dataset SQL is parameterized, identifiers are backend-derived, and cursors are opaque.

## Current status

Phase 1 is implemented through the frontend and automated evaluation. Opt-in live checks require local credentials and are intentionally excluded from ordinary development runs so they do not consume free-tier quota.
