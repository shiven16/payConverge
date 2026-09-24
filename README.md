# Payment State Convergence Engine

Merchant-side convergence engine for Hyperswitch webhooks. It demonstrates how a merchant can accept at-least-once, out-of-order payment webhooks, keep side effects idempotent, detect suspicious terminal conflicts, and repair drift by pulling authoritative payment state.

## Architecture

```mermaid
flowchart LR
  HS[Hyperswitch webhook] --> API[Fastify raw-body webhook API]
  API --> DB[(Postgres)]
  DB --> Engine[Convergence engine]
  Engine --> Authority[Mock or Hyperswitch authority]
  Engine --> Outbox[Transactional outbox]
  Outbox --> Workers[Mock order/inventory/notifier]
  Sweeper[Recovery sweeper] --> Authority
  Sweeper --> Engine
  API --> Metrics[/metrics]
  API --> Timeline[/payments/:id/timeline]
```

## State Model

Payment events are ordered by `content.object.updated` when present. A stored payment never regresses to an older provider timestamp. Terminal states are `succeeded`, `failed`, and `cancelled`. Contradictory terminal transitions such as `failed -> succeeded` are not blindly overwritten: the engine records a conflict, pulls authority, then reconciles to that result. A late success after a failed payment emits compensation commands instead of silently treating the old cancellation as final.

Supported payment webhook event names are `payment_succeeded`, `payment_failed`, `payment_processing`, `payment_cancelled`, `payment_authorized`, `payment_captured`, and `action_required`. Unknown events are stored and acknowledged.

## Guarantees

- Valid signed events are persisted before acknowledgement.
- Duplicate `event_id`s are acknowledged but not reapplied.
- State changes and business commands are recorded in the same transaction.
- Outbox commands use stable idempotency keys and `FOR UPDATE SKIP LOCKED`.
- The sweeper is safe to rerun and repairs known local payments whose webhooks were dropped.
- Metrics and timeline endpoints explain duplicates, stale ignores, conflicts, verification, commands, retries, and dead letters.

## Non-Guarantees

This is not settlement reconciliation, a ledger, multi-tenant auth, or a real PSP integration. Refund/dispute convergence is intentionally cut. Full outage repair assumes the merchant already has local payment intent rows to sweep; the harness seeds those rows to model checkout creation.

## Hyperswitch Facts Verified

Official docs/API reference used:

- Webhook guide: `https://docs.hyperswitch.io/integration-guide/webhooks.md`
- Outgoing webhook schema: `https://api-reference.hyperswitch.io/api-reference/schemas/outgoing--webhook`
- Payment retrieve API: `https://api-reference.hyperswitch.io/v1/payments/payments--retrieve`

Used facts: HMAC-SHA512 signature in `x-webhook-signature-512`; key is the business profile `payment_response_hash_key`; delivery expects 2xx and retries up to 16 attempts over roughly 24 hours; consumers should deduplicate by `event_id`; payment ordering uses `content.object.updated`; payment retrieval is `GET /payments/{payment_id}` with `api-key`.

## Run Locally

Start Postgres, the API, the outbox worker, and the recovery sweeper together:

```bash
cp .env.example .env
docker compose up -d --build
```

The API is available at `http://localhost:3000`. To run the TypeScript processes outside Docker instead, install dependencies and run the commands below; each loads values from `.env`:

```bash
npm install
npm run migrate
npm run dev
npm run worker
npm run sweeper
```

Send a correctly signed simulated webhook:

```bash
npm run demo:send -- pay_demo succeeded
curl http://localhost:3000/payments/pay_demo/timeline
curl http://localhost:3000/metrics
```

## Demo Scenarios

Happy path:

```bash
npm run demo:send -- pay_happy succeeded
npm run worker -- --once
curl http://localhost:3000/payments/pay_happy/timeline
```

Chaos run:

```bash
npm run chaos -- --seed=42 --payments=300
DISABLE_DEDUP=1 npm run chaos -- --seed=42 --payments=300 --expect-failure=true
```

Conflict:

```bash
npm run chaos -- --seed=7 --payments=50
curl http://localhost:3000/metrics
```

Outage recovery is covered by the chaos harness: it drops events while authority rows continue to move forward, then the sweeper repairs known local payment intents without webhook redelivery.

## Tests

```bash
npm test
```

Unit tests cover signature verification and convergence rules. Integration tests exercise Postgres deduplication, atomic state-plus-command recording, and idempotent delivery; they skip DB assertions when Postgres is not reachable.

## Deployment

Deploy the Docker image to Render, Railway, Fly.io, or any host that supports a container plus managed Postgres. Set:

- `DATABASE_URL`
- `WEBHOOK_SIGNING_KEY`
- `AUTHORITY_MODE=mock` or `hyperswitch`
- `HYPERSWITCH_BASE_URL`
- `HYPERSWITCH_API_KEY`
- `STUCK_AFTER_SECONDS`
- `OUTBOX_MAX_ATTEMPTS`

Run `npm run migrate` as a release step, then run the web process. Run `npm run worker` and `npm run sweeper` as background workers.

## Real vs Simulated

Real: raw-body HMAC verification, durable webhook ingestion, event deduplication, payment convergence, conflict handling, outbox retries, sweeper logic, metrics, timeline, and the real Hyperswitch payment retrieve client.

Simulated: generated webhook delivery faults, mock authority data, and mock merchant services for orders, inventory, and notifications.

## What I Would Do Next

Add refund-specific convergence, richer sweeper discovery from merchant order tables, OpenTelemetry export, a small static dashboard, and CI with a real Postgres service.
