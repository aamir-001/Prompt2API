# Phase 2 boundary: x402 on Hedera

Phase 2 is intentionally not implemented. Phase 1 keeps metadata, schema, and health routes separate from data-bearing routes and keeps dataset-query logic behind a service interface so future payment middleware can authorize a request before invoking it.

The future design is:

```text
consumer agent → dataset route → 402 requirements → Hedera payment
→ Blocky402 verification/settlement → retried request → Graph-derived response
```

Before implementation, re-verify the current x402, `@x402/hedera`, Blocky402 facilitator, and `hedera:testnet` APIs. Use a separate consumer process and separate payer credentials. Do not place payer keys in the IndexLoom API or browser.
