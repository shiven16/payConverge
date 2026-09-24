# Payment State Convergence Engine - Plan

## Stack
TypeScript + Node.js + Fastify + Postgres: small, mainstream backend stack with raw-body webhook access, fast tests, and simple container deployment.

## Verified Hyperswitch Facts Used
- Webhooks are signed with HMAC-SHA512 in `x-webhook-signature-512` using the business profile `payment_response_hash_key`.
- Valid deliveries should receive 2xx; retries run up to 16 attempts over roughly 24 hours.
- Duplicate deliveries can occur; `event_id` must be stored for idempotency.
- Payment webhook ordering should use `content.object.updated` where present.
- Payment retrieval is `GET /payments/{payment_id}` with `api-key`.

## Components
- HTTP API: webhook ingestion, metrics, per-payment timeline, dead-letter retry.
- Convergence engine: payment-only state machine, stale/duplicate/conflict decisions, authority verification.
- Authority clients: mock in-memory/DB-backed authority for tests/demo; real Hyperswitch sandbox client via env.
- Outbox workers: reliable command delivery to mock order, inventory, notifier services.
- Sweeper: repairs stuck/inconsistent payments by pulling authority.
- Chaos harness: seeded lifecycle generator, adversarial delivery, oracle, invariant checks.

## Data Model Outline
- `webhook_events`: durable inbound events keyed by `event_id`.
- `payments`: merchant view, status, provider updated timestamp, flags, authoritative status.
- `payment_decisions`: timeline entries with human-readable reason.
- `conflicts`: suspicious/contradictory cases and resolution status.
- `outbox_commands`: atomic business commands with stable idempotency keys, retry/dead-letter fields.
- `merchant_effects`: mock downstream observed effects keyed by idempotency key.
- `authority_payments`: mock authoritative state used by demos/tests/harness.
- `metrics_counters`, `convergence_lags`: lightweight observability.

## Build Order
- 0:00-0:20: Scaffold repo, env, Docker Compose, migrations.
- 0:20-0:55: Webhook signature verification, durable dedup, unknown event storage.
- 0:55-1:35: Payment convergence, conflict detection, authority abstraction.
- 1:35-2:05: Atomic outbox commands and mock merchant consumers with retries/DLQ.
- 2:05-2:35: Sweeper and outage repair path.
- 2:35-3:10: Chaos harness and bug switch.
- 3:10-3:30: Tests, README, deployment notes, final cleanup.

## Cut List
- Cut optional dashboard.
- Cut refunds.
- Keep real Hyperswitch authority if time allows; otherwise document mock-only path honestly.
- Keep sweeper heuristic simple: non-terminal/stale or conflict-pending payments.

## Test Plan
- Unit: signature verification, status ordering, stale/conflict decisions.
- Integration: Postgres-backed concurrent dedup, atomic state + command creation, retry to dead-letter.
- System: chaos harness with fixed seed must pass; deliberate `DISABLE_DEDUP=1` run must fail.

## Status
- Planned. No implementation yet.
