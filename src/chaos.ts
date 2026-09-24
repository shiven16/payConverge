import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ingestValidEvent } from "./engine.js";
import { adversarialDelivery, generatePayments, resetAll, seedAuthority } from "./harness-utils.js";
import { runSweeper } from "./sweeper.js";
import { deliverDueCommands } from "./worker.js";
import { HyperswitchWebhook, PaymentStatus } from "./types.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));
const seed = Number(args.get("seed") ?? Date.now());
const count = Number(args.get("payments") ?? 300);
const expectFailure = args.get("expect-failure") === "true";
const concurrent = args.get("concurrent") === "true";

if (process.env.CHAOS_ALLOW_RESET !== "1") {
  throw new Error("Chaos truncates project tables; set CHAOS_ALLOW_RESET=1 only on a disposable test database");
}

await resetAll();
await pool.query("UPDATE runtime_controls SET enabled = true");
const payments = generatePayments(seed, count);
await seedAuthority(payments);
const delivery = adversarialDelivery(seed, payments);
const authorityOracle = referenceConsume(payments.map((payment) => payment.events));
const previousModes = new Map<string, string | undefined>();
for (const target of ["ORDER_SERVICE_MODE", "INVENTORY_SERVICE_MODE", "NOTIFIER_SERVICE_MODE"]) {
  previousModes.set(target, process.env[target]);
  process.env[target] = "error";
}

let stopServices = false;
const serviceTasks: Promise<void>[] = [];
if (concurrent) {
  for (let index = 0; index < 3; index++) {
    serviceTasks.push((async () => {
      while (!stopServices) {
        await deliverDueCommands(20);
        await sleep(5);
      }
    })());
  }
  serviceTasks.push((async () => {
    while (!stopServices) {
      await runSweeper(50);
      await sleep(10);
    }
  })());
}

try {
  if (concurrent) {
    for (let offset = 0; offset < delivery.delivered.length; offset += 32) {
      const batch = delivery.delivered.slice(offset, offset + 32);
      await Promise.all(batch.map((payload) => ingest(payload)));
    }
  } else {
    for (const payload of delivery.delivered) await ingest(payload);
  }

  for (let index = 0; index < 4; index++) await runSweeper(count);

  if (concurrent) {
    for (let index = 0; index < 1000; index++) {
      const unattempted = await pool.query("SELECT count(*)::int AS count FROM outbox_commands WHERE status = 'pending'");
      if (unattempted.rows[0].count === 0) break;
      await sleep(20);
    }
  } else {
    await deliverDueCommands(1000);
  }
} finally {
  stopServices = true;
  await Promise.all(serviceTasks);
  for (const [key, value] of previousModes) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

await pool.query("UPDATE outbox_commands SET next_attempt_at = now() WHERE status = 'retry'");
for (let index = 0; index < config().outboxMaxAttempts + 2; index++) {
  const countDelivered = await deliverDueCommands(1000);
  if (countDelivered === 0) break;
}
for (let index = 0; index < 3; index++) await runSweeper(count);

const stateRows = await pool.query("SELECT payment_id, status FROM payments");
const decisionRows = await pool.query(
  "SELECT payment_id, kind, details FROM payment_decisions WHERE kind IN ('applied', 'verification_pulled') ORDER BY id"
);
const conflictRows = await pool.query(
  `SELECT c.payment_id, c.event_id, c.status, p.conflict_pending,
          EXISTS(SELECT 1 FROM payment_decisions d WHERE d.payment_id = c.payment_id AND d.event_id IS NOT DISTINCT FROM c.event_id AND d.kind = 'conflict_detected') AS detected
   FROM conflicts c JOIN payments p USING(payment_id)`
);
const commandRows = await pool.query("SELECT idempotency_key, command_type, target, status FROM outbox_commands");
const effectRows = await pool.query("SELECT idempotency_key, count(*)::int AS count FROM merchant_effects GROUP BY idempotency_key");
const counters = await pool.query("SELECT name, value FROM metrics_counters");
const lagRows = await pool.query("SELECT milliseconds FROM convergence_lags ORDER BY milliseconds");

const actualStates = new Map(stateRows.rows.map((row) => [row.payment_id, row.status as PaymentStatus]));
const finalStateMatches = [...authorityOracle].every(([paymentId, status]) => actualStates.get(paymentId) === status);
const statusOrder: Record<PaymentStatus, number> = {
  requires_payment_method: 0,
  requires_confirmation: 1,
  requires_customer_action: 2,
  requires_merchant_action: 3,
  processing: 4,
  authorized: 5,
  partially_captured: 6,
  succeeded: 7,
  failed: 7,
  cancelled: 7
};
const noRegression = decisionRows.rows.every((row) => {
  if (row.kind === "verification_pulled") return true;
  const previous = row.details.previous_status as PaymentStatus | null;
  const next = row.details.next_status as PaymentStatus;
  return previous === null || (statusOrder[next] >= statusOrder[previous] && !(isTerminal(previous) && previous !== next));
});
const expectedCommands = new Set<string>();
for (const [paymentId, status] of authorityOracle) {
  if (status === "succeeded") {
    expectedCommands.add(`${paymentId}:fulfil_order:orders`);
    expectedCommands.add(`${paymentId}:notify_success:notifier`);
  } else if (status === "failed" || status === "cancelled") {
    expectedCommands.add(`${paymentId}:cancel_order:orders`);
    expectedCommands.add(`${paymentId}:release_stock:inventory`);
    expectedCommands.add(`${paymentId}:notify_failure:notifier`);
  }
}
const actualCommandKeys = new Set(commandRows.rows.map((row) => row.idempotency_key as string));
const deliveredCommandKeys = new Set(commandRows.rows.filter((row) => row.status === "delivered").map((row) => row.idempotency_key as string));
const effectsAtMostOnce = effectRows.rows.every((row) => Number(row.count) === 1);
const noMissingCommands = [...expectedCommands].every((key) => actualCommandKeys.has(key) && deliveredCommandKeys.has(key));
const expectedConflictPayments = new Set(payments.filter((payment) =>
  payment.finalStatus === "failed"
  && delivery.delivered.some((event) => event.content?.object?.payment_id === payment.paymentId && event.content?.object?.status === "failed")
  && delivery.delivered.some((event) => event.content?.object?.payment_id === payment.paymentId && String(event.event_id).endsWith("_late_conflict"))
).map((payment) => payment.paymentId));
const observedConflictPayments = new Set(conflictRows.rows.map((row) => row.payment_id as string));
const everyConflictObserved = [...expectedConflictPayments].every((paymentId) => observedConflictPayments.has(paymentId));
const allConflictRowsVisible = conflictRows.rows.every((row) =>
  row.detected && (row.status === "resolved" || (row.status === "pending" && row.conflict_pending))
);
const conflictsHandled = everyConflictObserved && allConflictRowsVisible;
const transientFailureRecovered = Number(counters.rows.find((row) => row.name === "delivery_retries")?.value ?? 0) > 0
  && Number(counters.rows.find((row) => row.name === "dead_letter_count")?.value ?? 0) === 0
  && noMissingCommands;
const duplicatesDropped = Number(counters.rows.find((row) => row.name === "duplicates_dropped")?.value ?? 0);
const duplicateSafeguard = delivery.duplicated === 0 || duplicatesDropped >= delivery.duplicated;
const lags = lagRows.rows.map((row) => Number(row.milliseconds));
const invariants = {
  a_final_state_matches_independent_oracle_after_sweep: finalStateMatches,
  b_state_never_regresses_on_stale_events: noRegression,
  c_expected_commands_delivered_once_by_idempotency_key: effectsAtMostOnce && noMissingCommands,
  d_every_conflict_resolved_by_authority_or_remains_flagged: conflictsHandled,
  e_transient_consumer_failures_do_not_lose_commands: transientFailureRecovered,
  duplicate_safeguard_observed: duplicateSafeguard
};
const failed = Object.entries(invariants).filter(([, value]) => !value).map(([name]) => name);
const summary = {
  seed,
  mode: concurrent ? "concurrent-workers-and-sweeper" : "sequential",
  payments: count,
  events_generated: payments.reduce((sum, payment) => sum + payment.events.length, 0),
  events_delivered: delivery.delivered.length,
  duplicated: delivery.duplicated,
  reordered: delivery.reordered,
  delayed: delivery.delayed,
  dropped: delivery.dropped,
  stale_conflicts_injected: delivery.staleInjected,
  stale_ignored: Number(counters.rows.find((row) => row.name === "stale_events_ignored")?.value ?? 0),
  conflicts_detected: conflictRows.rowCount ?? 0,
  expected_conflicting_payments: expectedConflictPayments.size,
  conflicts_resolved: conflictRows.rows.filter((row) => row.status === "resolved").length,
  payments_repaired_by_sweeper: Number(counters.rows.find((row) => row.name === "payments_repaired_by_sweeper")?.value ?? 0),
  delivery_retries: Number(counters.rows.find((row) => row.name === "delivery_retries")?.value ?? 0),
  commands_expected: expectedCommands.size,
  commands_delivered: deliveredCommandKeys.size,
  convergence_lag_ms_p50: percentile(lags, 0.5),
  convergence_lag_ms_p95: percentile(lags, 0.95),
  invariants,
  conflict_audit: {
    expected_payment_count: expectedConflictPayments.size,
    observed_payment_count: observedConflictPayments.size,
    missing_payments: [...expectedConflictPayments].filter((paymentId) => !observedConflictPayments.has(paymentId)),
    all_rows_visible_and_resolved_or_flagged: allConflictRowsVisible
  },
  replay: `CHAOS_ALLOW_RESET=1 npm run chaos -- --seed=${seed} --payments=${count}${concurrent ? " --concurrent=true" : ""}`
};
console.log(JSON.stringify(summary, null, 2));
await pool.end();

if (failed.length > 0 && !expectFailure) {
  console.error(`Chaos failed for seed ${seed}: ${failed.join(", ")}`);
  process.exit(1);
}
if (failed.length === 0 && expectFailure) {
  console.error(`Expected invariant failure did not occur for seed ${seed}`);
  process.exit(1);
}

async function ingest(payload: HyperswitchWebhook) {
  await ingestValidEvent(JSON.stringify(payload), payload, extractForHarness(payload));
}

function referenceConsume(lifecycles: HyperswitchWebhook[][]): Map<string, PaymentStatus> {
  const ranks: Record<PaymentStatus, number> = {
    requires_payment_method: 0,
    requires_confirmation: 1,
    requires_customer_action: 2,
    requires_merchant_action: 3,
    processing: 4,
    authorized: 5,
    partially_captured: 6,
    succeeded: 7,
    failed: 7,
    cancelled: 7
  };
  const result = new Map<string, PaymentStatus>();
  for (const lifecycle of lifecycles) {
    const ordered = [...lifecycle].sort((left, right) => eventTime(left) - eventTime(right));
    for (const event of ordered) {
      const object = event.content?.object;
      const paymentId = object?.payment_id ?? object?.id;
      const status = object?.status as PaymentStatus | undefined;
      if (!paymentId || !status) continue;
      const current = result.get(paymentId);
      if (!current || (!isTerminal(current) && ranks[status] >= ranks[current])) result.set(paymentId, status);
    }
  }
  return result;
}

function extractForHarness(payload: HyperswitchWebhook) {
  const object = payload.content?.object;
  return {
    eventId: String(payload.event_id ?? ""),
    eventType: String(payload.type ?? payload.event_type ?? "unknown"),
    paymentId: typeof object?.payment_id === "string" ? object.payment_id : null,
    status: typeof object?.status === "string" ? object.status as PaymentStatus : null,
    providerUpdatedAt: typeof object?.updated === "string" ? new Date(object.updated) : null
  };
}

function eventTime(event: HyperswitchWebhook) {
  return Date.parse(String(event.content?.object?.updated ?? ""));
}

function isTerminal(status: PaymentStatus) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];
}
