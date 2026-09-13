# Prompt2API Graph bounty demo

Target length: 3 minutes 30 seconds. Keep the browser, API logs, and PostgreSQL query tool visible in separate windows before recording.

## 0:00–0:20 — The problem and boundary

Open the empty Create Pipeline page.

> Blockchain data pipelines normally require event decoding, indexing code, infrastructure, and a custom API. Prompt2API turns a focused data request into a live reusable API. In Phase 1 the AI is deliberately constrained: it can configure a reviewed ERC-4626 template, but it cannot write Rust, SQL, dependencies, paths, or shell commands.

Point at the Phase 1 scope strip: Base, ERC-4626, Deposit/Withdraw, and one to three explicit vaults.

## 0:20–0:45 — One natural-language prompt

Click **Use example** and submit this prompt:

> Track Deposit and Withdraw events for ERC-4626 vault 0x050ce30b927da55177a4914ec73480238bad56f0 on Base starting at block 50999146. Normalize the events and expose raw records and hourly net flows.

> Gemini returns only a strict structured plan. Zod and viem validate it again on the backend. Everything executable is derived deterministically from reviewed code.

## 0:45–1:15 — Standards and composition

On the plan screen, show the normalized vault, start block, and selected events. Then point to the module graph and filter.

> This pipeline composes the pinned `ethereum-common@v0.3.3` package. Its indexed `filtered_events` module limits the stream to the configured vault and standard ERC-4626 topics. Our reusable WASM module decodes those events into one normalized schema, and `db_out` feeds PostgreSQL. The address and event topics in this filter are backend-derived—the model never generates this expression.

Click **Build & validate**.

For the shortest live demo, run `pnpm warm:substreams` once before presenting. Generated
pipelines fingerprint the reviewed compiler inputs and package the matching cached WASM.
If any trusted Rust, protobuf, or ABI input changes, the runner recompiles automatically.

## 1:15–1:50 — Build and live Graph proof

As the page polls, show the build, package inspection, graph inspection, and live validation stages. The on-screen stage guide explains what each trusted step proves. The default demo validation samples a deterministic 100-block range; Gemini does not choose or expand it.

> The backend runs the installed Substreams CLI through a constrained, non-shell process runner. Output is bounded and secrets are redacted. Validation consumes live Base blocks from The Graph provider; these are not static demo records.

When validation finishes, show the checklist and decoded Deposit/Withdraw preview. Open one transaction hash and point out the vault, owner, raw assets, block, and deterministic event ID.

## 1:50–2:15 — Hash-bound approval and sink

Show the configuration and package hashes, then click **Approve & deploy**.

> Human approval is bound to the exact source configuration and built package shown here. If either artifact changes, approval fails. The approved `.spkg` starts the PostgreSQL sink at the requested block. Its stored cursor lets it resume after a restart without duplicating events.

Briefly show the deployment becoming `LIVE` and, in PostgreSQL, query:

```sql
SELECT event_type, count(*)
FROM dataset_<pipeline_id>.vault_events
GROUP BY event_type;
```

## 2:15–2:45 — Reusable API

Open the dataset screen. Show the indexed-through block, raw events, hourly flows, schema tab, and copyable cURL example.

Run the copied request and show a real event response.

> The same REST shape works across every configured ERC-4626 vault. Raw uint256 amounts remain decimal strings, filters are typed, queries are parameterized, and pagination uses opaque cursors. Hourly inflow, outflow, and net flow are computed in PostgreSQL without recompiling WASM.

## 2:45–3:20 — Paid request and settlement

On the live dataset page, click **Pay 0.001 HBAR & load data** and confirm the explicit testnet-payment prompt.

> The free metadata describes the price, while raw events and hourly flows return HTTP 402 payment requirements. The separate payer validates the network, asset, amount, recipient, fee payer, and route before signing. Blocky402 verifies and settles the transfer on Hedera testnet, then the same request returns Graph-derived data with a payment receipt.

Show the loaded rows and click the HashScan settlement link. Keep the private key, environment files, and authorization headers off screen.

## 3:20–3:30 — Close

> The Graph is load-bearing from historical validation through continuous synchronization, while x402 on Hedera meters the reusable data route without changing the underlying pipeline.

End on: **One prompt → composed Substreams → live Graph data → reusable API.**

## Recording checklist

- Use a real Graph Market token and show at least one live matching event.
- Keep credentials, DSNs, environment files, and authorization headers off screen.
- Keep the final video between two and four minutes.
- Do not describe fixtures or mocked tests as deployment proof.
- Show `ethereum-common@v0.3.3`, the module graph, both hashes, the sink cursor, and one API response.
- Show one explicit frontend x402 purchase, the returned rows, and the successful HashScan settlement.
