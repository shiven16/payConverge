# PayConverge

PayConverge is a merchant-side payment state convergence engine built around Hyperswitch webhook delivery. Hyperswitch retries failed webhooks up to 16 times over roughly 24 hours, so a longer merchant outage can leave local state silently behind. Deduplicating `event_id` and ordering payment updates by `content.object.updated` are the documented baseline; this project focuses on authority-backed repair, reversible/idempotent business effects, and proving behavior under adversarial delivery. It is not settlement-file reconciliation.

## Architecture

```mermaid
flowchart LR
  HS[Hyperswitch webhook] --> API[Fastify API]
  API --> PG[(Postgres)]
  API --> Engine[Convergence engine]
  Engine --> Authority[Mock or Hyperswitch retrieve]
  Engine --> Outbox[Transactional outbox]
  Outbox --> Consumers[Mock order inventory notifier]
  Sweeper[Recovery sweeper] --> Authority
  Sweeper --> Engine
  API --> Metrics[/metrics]
  API --> Timeline[/payments/:id/timeline]
```

## State Model

Supported event types are `payment_succeeded`, `payment_failed`, `payment_processing`, `payment_cancelled`, `payment_authorized`, `payment_captured`, and `action_required`. Event status is read from `content.object.status` (with event-type mapping as fallback); unsupported events, including `payment_expired`, are durably recorded and acknowledged but do not change payment state.

The non-terminal progression is `requires_payment_method < requires_confirmation < requires_customer_action < requires_merchant_action < processing < authorized < partially_captured`; `succeeded`, `failed`, and `cancelled` are terminal. A non-terminal update cannot replace an already-terminal state. Older `content.object.updated` values are ignored. At equal timestamps, the explicit progression rank breaks ties, so a lower-ranked status cannot regress a higher-ranked one. Contradictory terminal states are recorded as conflicts and verified against the configured authority; they are never resolved by timestamp alone. When event timestamps are missing, arrival order is used for non-terminal updates, while terminal-regression and conflict rules still apply.

## Guarantees and Limits

- Valid signed webhook payloads are stored before the endpoint acknowledges them; a database uniqueness constraint and payment-scoped advisory transaction lock serialize duplicate and first-event races.
- State updates and generated commands commit in one transaction. Outbox workers claim rows using `FOR UPDATE SKIP LOCKED`; command idempotency keys protect downstream effects. The mock consumers persist effect keys transactionally.
- The sweeper and ingestion use the same per-payment advisory lock, and multiple sweepers skip payments already being processed. The sweeper repairs registered payments, not unknown checkout intents.
- Conflicts are retained in the timeline and resolved from authority or left visibly flagged when authority is unavailable.
- The chaos harness uses a separate reference consumer and checks convergence after sweep, stale-event monotonicity, command delivery/idempotency, conflict visibility/resolution, and transient-failure recovery.
- This does not provide exactly-once network delivery; it provides retryable delivery with idempotent effects. Signature verification authenticates the raw body only, not freshness. `event_id` deduplication is the replay defense.
- Refunds, disputes, authentication, ledger behavior, real merchant systems, and settlement reconciliation are out of scope. Use HTTPS when exposing the endpoint publicly.

## Hyperswitch Contract

The implementation follows the official [webhook guide](https://docs.hyperswitch.io/integration-guide/webhooks.md), [outgoing webhook schema](https://api-reference.hyperswitch.io/api-reference/schemas/outgoing--webhook), and [payment retrieve API](https://api-reference.hyperswitch.io/v1/payments/payments--retrieve). The verified webhook contract used here includes `event_id`, `x-webhook-signature-512`, HMAC-SHA512 over the raw body with the business profile `payment_response_hash_key`, and the payment ordering timestamp `content.object.updated`. The retrieve client calls `GET /payments/{payment_id}` with `api-key`.

The retrieve client is implemented against the documented API, **not yet run against a Hyperswitch sandbox**. No sandbox credentials were available for this verification.

## Run Locally

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:3000/healthz
```

Compose starts Postgres, API, worker, and sweeper. The sample signing key is for local use only. For local processes outside Docker, install dependencies, ensure `.env` points to a reachable Postgres, then run migrations and processes in separate terminals:

```bash
npm install
npm run migrate
npm run dev
npm run worker
npm run sweeper
```

The merchant must register a payment intent before a webhook-free outage can be repaired:

```bash
curl -X POST http://localhost:3000/payments/pay_demo/register
```

`POST /payments/:paymentId/register` is idempotent. Other endpoints: `POST /webhooks/hyperswitch`, `GET /metrics`, `GET /payments/:paymentId/timeline`, `GET /dead-letters`, and `POST /dead-letters/:id/retry`.

## Demos

Signed simulated happy path:

```bash
npm run demo:send -- pay_happy succeeded
curl http://localhost:3000/payments/pay_happy/timeline
```

Conflict (failure, then a late success with an older provider timestamp):

```bash
npm run demo:scenario -- conflict
```

Expected output includes `conflict_detected`, `verification_pulled`, and a delivered `compensate_late_success` command. The script prints the generated payment ID and timeline evidence.

Outage recovery (three registered payments move in mock authority while webhook ingestion and the sweeper are disabled; no webhook redelivery is performed):

```bash
npm run demo:scenario -- outage
```

Expected JSON reports `webhook_attempts_rejected: 3`, `webhook_redeliveries: 0`, drift before the sweep, drift after the sweep as `0`, and `repaired_by_sweeper: 3`.

Chaos runs need an isolated/throwaway database because the harness resets its test tables. Enable that destructive action explicitly:

```bash
CHAOS_ALLOW_RESET=1 npm run chaos -- --seed=17 --payments=300
CHAOS_ALLOW_RESET=1 npm run chaos -- --seed=17 --payments=300 --concurrent=true
```

The concurrent mode runs multiple delivery workers and the sweeper alongside event ingestion. Runs print the seed and replay command. To verify the harness catches a disabled dedup safeguard, run the same seed with `DISABLE_DEDUP=1`; the command exits nonzero on violated invariants and prints a replayable seed:

```bash
CHAOS_ALLOW_RESET=1 DISABLE_DEDUP=1 npm run chaos -- --seed=17 --payments=300
```

Reset the isolated DB between chaos runs if needed. Captured run output should be added here after running these commands against the current checkout; no sample numbers are claimed in this README.

## Tests

The test suite includes unit tests for signature verification and state rules, plus Postgres integration tests for concurrent duplicate/first-event ingestion, transactional rollback, multiple concurrent workers, and concurrent sweepers/live ingestion. Integration tests fail by default if Postgres is unavailable; skipping them requires an explicit `SKIP_DB_TESTS=1`.

```bash
docker compose up -d postgres
npm test
SKIP_DB_TESTS=1 npm test
```

The second command is a deliberate unit-only run and reports the database tests as skipped. CI runs the suite against a Postgres service container.

## Deployment

`render.yaml` defines a Render Docker web service and managed Postgres database. Create a Blueprint deployment from that file, set the secrets in the Render dashboard, and configure Hyperswitch's webhook destination to the HTTPS `/webhooks/hyperswitch` URL with the matching signing key. `RUN_BACKGROUND_PROCESSES=true` runs worker and sweeper loops inside the web process for a single-service deployment; set it to `false` when running separate worker processes. Do not scale this embedded-worker setup into multiple web replicas unless you intend to run a worker loop per replica (database locking prevents duplicate claims).

Live URL: **not deployed** (placeholder).

## Real vs Simulated

Real implementation: raw-body HMAC verification, Postgres-backed ingestion/deduplication, transition and conflict rules, transactionally recorded outbox commands, retries/dead letters, recovery logic, API metrics/timeline, and the Hyperswitch retrieve client implemented against its documented API. The retrieve client has not been sandbox-tested.

Simulated: generated Hyperswitch-shaped events and delivery faults in the chaos harness, the mock authority used by local demos, and mock order/inventory/notifier consumers. No real merchant side effects are performed.

## Next

Run the retrieve client against sandbox credentials, capture the chaos and demo outputs above, then add refund-specific ordering and operational tracing if scope permits.
