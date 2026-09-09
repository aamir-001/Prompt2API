# Phase 1 architecture

## Trust boundaries

IndexLoom separates interpretation from execution. Gemini receives a builder prompt and a JSON Schema derived from the Zod `PlannerResultSchema`. It can return a ready `PipelineSpec`, clarification questions, or an unsupported classification. Its output is never a command or source file.

The backend parses the response as JSON and validates it with the same strict Zod contract. It then validates and normalizes every address with `viem`, enforces Base/ERC-4626/event/block/count limits, derives event selectors and filter expressions, and creates safe identifiers. Only this validated representation reaches the template renderer.

The renderer copies an allowlisted reviewed template. Fixed Rust, Protobuf, ABI, SQL, lockfile, and toolchain files must match their expected content. Only reviewed manifest/readme placeholders vary. An artifact manifest records hashes for later approval verification.

## Runtime flow

```mermaid
sequenceDiagram
    actor Builder
    participant Web
    participant API
    participant Gemini
    participant Queue as PostgreSQL queue
    participant CLI as Substreams CLI
    participant Graph as Graph provider
    participant Sink as PostgreSQL sink

    Builder->>Web: Natural-language request
    Web->>API: POST /pipelines/plan
    API->>Gemini: Prompt + derived JSON Schema
    Gemini-->>API: Structured PlannerResult
    API->>API: Zod + viem validation and deterministic derivation
    API-->>Web: PLAN_READY
    Builder->>Web: Build and validate
    Web->>API: POST /build
    API->>Queue: Enqueue one FIFO job
    Queue->>CLI: build, info, graph
    CLI->>Graph: Live Base validation range
    Graph-->>CLI: Filtered event stream
    CLI-->>API: Normalized JSONL preview
    API-->>Web: AWAITING_APPROVAL + exact hashes
    Builder->>Web: Approve exact hashes
    Web->>API: POST /approve
    API->>API: Re-hash every artifact and package
    API->>Sink: Setup schema and start approved package
    Sink->>Graph: Historical + live stream
    Sink->>Sink: Upsert events and cursor
    API-->>Web: LIVE dataset API
```

## State and recovery

All pipeline transitions are checked by a plain TypeScript state machine and persisted with timestamps and reasons. PostgreSQL stores the single-job FIFO queue. Startup marks interrupted build/validation runs as failed and restarts deployments recorded as live. The SQL sink resumes from its stored cursor; deterministic event IDs prevent duplicate records.

## Data model

`map_vault_events` emits immutable normalized events with lowercase addresses, raw decimal `uint256` strings, block/transaction/log metadata, and an event ID of `base-mainnet:<transaction-hash>:<log-index>`. `db_out` writes those events. PostgreSQL views derive hourly inflow, outflow, net flow, counts, and unique owners. The dataset service adds validated filters and keyset pagination without exposing SQL.

## Process isolation

The Phase 1 runner is intentionally direct because it compiles only operator-reviewed templates. It uses `spawn` with `shell: false`, fixed commands, canonical paths under the artifact root, output limits, timeouts, cancellation, and a reduced environment. The build receives no secrets; live validation receives only the Graph token; the sink receives the Graph token and DSN.

Allowing arbitrary source, Cargo dependencies, build scripts, uploaded packages, or model-generated executable content would invalidate this boundary and require isolated container/VM compilation before public use.
