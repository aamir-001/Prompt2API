# Phase 2: x402 on Hedera

Phase 2 is implemented with x402 v2, native HBAR on Hedera testnet, and the hosted Blocky402 testnet facilitator. The payer remains a separate process; neither the API nor browser receives its private key.

## End-to-end flow

```text
consumer agent
  -> GET /v1/datasets/:slug/events
  <- 402 + PAYMENT-REQUIRED
  -> validate v2 / exact / hedera:testnet / HBAR / amount / recipient / fee payer
  -> create and sign a Hedera transfer authorization locally
  -> retry GET with PAYMENT-SIGNATURE
  -> API asks Blocky402 to verify the payload
  -> dataset handler returns Graph-derived PostgreSQL data
  -> API asks Blocky402 to settle the transfer
  <- 200 data + PAYMENT-RESPONSE Hedera receipt
```

The initial dataset lookup and synchronization check happen before the payment challenge. A missing or unavailable dataset cannot collect a payment.

## Route policy

| Route | Access |
| --- | --- |
| `GET /v1/datasets/:slug/meta` | Free |
| `GET /v1/datasets/:slug/schema` | Free |
| `GET /v1/datasets/:slug/health` | Free |
| `GET /v1/datasets/:slug/events` | x402 paid |
| `GET /v1/datasets/:slug/flows/hourly` | x402 paid |
| `GET /v1/datasets/:slug/top-depositors` | Free; not a Phase 2 paid product |

The default price is `100000` tinybars, equal to `0.001 HBAR`, per paid HTTP request. Pricing is exposed in free metadata and persisted in the control-plane `api_products.pricing` field for live pipelines.

## Resource server

`apps/api/src/payment.ts` uses pinned official packages:

- `@x402/core@2.25.0`
- `@x402/express@2.25.0`
- `@x402/hedera@2.25.0`

At startup, `HTTPFacilitatorClient` loads Blocky402 `/supported`. `ExactHederaScheme` then enriches the payment requirements with the facilitator-owned Hedera fee-payer account. Startup fails instead of serving unusable payment requirements if the configured facilitator does not support the selected scheme and network.

The API never signs a payer transaction. It receives the opaque payment payload and delegates verification and settlement to the facilitator. Successful paid responses carry the x402 v2 `PAYMENT-RESPONSE` header.

## Consumer agent

`apps/consumer-agent` is the only process that loads `HEDERA_PAYER_ACCOUNT_ID` and `HEDERA_PAYER_PRIVATE_KEY`.

Before signing, its policy requires all of the following:

1. x402 version 2.
2. `exact` payment scheme.
3. `hedera:testnet` network.
4. Native HBAR asset `0.0.0`.
5. The configured recipient account.
6. A syntactically valid facilitator fee-payer account.
7. An integer amount no greater than `X402_MAX_AMOUNT`.
8. A locally constructed Prompt2API dataset URL and allowlisted resource.

It uses the official `wrapFetchWithPayment` transport. The private key is used in memory to create the Hedera payload and is never printed.

Configure `apps/consumer-agent/.env` from its example, then run:

```bash
pnpm --filter @prompt2api/consumer-agent dev -- <dataset-slug> events
pnpm --filter @prompt2api/consumer-agent dev -- <dataset-slug> hourly-flows
```

The output contains the dataset response, settlement status, transaction ID, payer, any amount echoed by the facilitator, and a HashScan testnet URL.

## Frontend demo purchase

The dataset screen includes a **Pay 0.001 HBAR & load data** button for a visible hackathon demonstration. After an explicit browser confirmation, a same-origin Next.js route starts the consumer agent as a restricted child process using `execFile` with a fixed executable and strictly validated dataset/resource arguments. This is process separation, not an OS/container sandbox. No shell is involved, and user input cannot select a command, path, payment amount, network, asset, or recipient.

The agent completes the same x402 challenge, verification, and settlement flow described above. The server returns only the dataset response and settlement receipt, after which the browser renders the purchased rows and a HashScan link. The payer private key remains in `apps/consumer-agent/.env`; it is never loaded into client JavaScript, returned by the route, or logged.

Local development permits the demo route only on loopback and requires a same-origin browser request. Additional safeguards include:

- an explicit confirmation before each payment;
- a ten-second per-session/resource cooldown by default;
- a maximum of 25 purchase attempts per frontend process by default;
- a fixed 60-second child-process timeout;
- the consumer agent's existing recipient, network, asset, fee-payer, and maximum-amount policy.

Localhost development does not require an operator login. Production keeps the route disabled unless `DEMO_PURCHASE_ENABLED=true` and always requires a valid `OPERATOR_API_TOKEN` session. Configure production-only frontend values in `apps/web/.env.local` using `apps/web/.env.example`; do not put the payer key there. This is a testnet demo-payer experience, not a substitute for a user-controlled Hedera wallet.

## Configuration

Resource server in the root `.env`:

```dotenv
X402_ENABLED=true
X402_NETWORK=hedera:testnet
X402_SCHEME=exact
X402_ASSET=0.0.0
X402_PRICE=100000
X402_PAY_TO=0.0.10442846
X402_FACILITATOR_URL=https://api.testnet.blocky402.com
X402_MAX_TIMEOUT_SECONDS=300
X402_FACILITATOR_TIMEOUT_MS=30000
```

Payer agent in `apps/consumer-agent/.env`:

```dotenv
HEDERA_PAYER_ACCOUNT_ID=0.0.10442861
HEDERA_PAYER_PRIVATE_KEY=0x...
PROMPT2API_API_URL=http://localhost:4000
X402_NETWORK=hedera:testnet
X402_ASSET=0.0.0
X402_MAX_AMOUNT=100000
X402_EXPECTED_PAY_TO=0.0.10442846
```

Both `.env` files are Git-ignored. Public account IDs are configuration, while the payer private key is secret.

Optional frontend demo limits in `apps/web/.env.local`:

```dotenv
DEMO_PURCHASE_ENABLED=false
DEMO_PURCHASE_COOLDOWN_MS=10000
DEMO_PURCHASE_MAX_PER_PROCESS=25
DEMO_PURCHASE_TIMEOUT_MS=60000
OPERATOR_API_TOKEN=
```

## Verification

Quota-free mocked tests cover free-route bypass, unpaid challenge shape, settlement, replay rejection, payer-policy failures, unsafe dataset slugs, and the API route boundary.

One real testnet payment is opt-in:

```bash
RUN_LIVE_X402_TEST=1 pnpm --filter @prompt2api/consumer-agent test:live -- <dataset-slug>
```

Without `RUN_LIVE_X402_TEST=1`, the command exits without signing or spending.

Official references: [x402 protocol documentation](https://docs.x402.org/introduction), [Blocky402 facilitator and Hedera example](https://blocky402.com/), and the [x402 Foundation TypeScript implementation](https://github.com/x402-foundation/x402).

### Recorded live proof

On 2026-09-12, the opt-in test returned paid Graph-derived data and a successful Hedera settlement:

- Transaction: `0.0.7162784@1789263522.289793033`
- Result: `SUCCESS`
- Payer transfer: `0.0.10442861` debited `100000` tinybars
- Recipient transfer: `0.0.10442846` credited `100000` tinybars

The public Hedera testnet mirror node independently reported the successful `CRYPTOTRANSFER`. Facilitator/network fees were paid by the Blocky402 fee-payer account, not by the Prompt2API recipient.
