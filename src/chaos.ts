import { config } from "./config.js";
import { pool } from "./db.js";
import { ingestValidEvent } from "./engine.js";
import { extractEvent } from "./state.js";
import { adversarialDelivery, generatePayments, resetAll, seedAuthority } from "./harness-utils.js";
import { runSweeper } from "./sweeper.js";
import { deliverDueCommands } from "./worker.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const seed = Number(args.get("seed") ?? Date.now());
const count = Number(args.get("payments") ?? 300);
const expectFailure = args.get("expect-failure") === "true";

await resetAll();
const payments = generatePayments(seed, count);
await seedAuthority(payments);
const delivery = adversarialDelivery(seed, payments);

for (const payload of delivery.delivered) {
  const raw = JSON.stringify(payload);
  await ingestValidEvent(raw, payload, extractEvent(payload));
}

for (let i = 0; i < 3; i++) await runSweeper(count);
for (let i = 0; i < config().outboxMaxAttempts + 2; i++) await deliverDueCommands(1000);

const finalStates = await pool.query("SELECT payment_id, status FROM payments");
const effects = await pool.query("SELECT idempotency_key, count(*)::int AS count FROM merchant_effects GROUP BY idempotency_key HAVING count(*) > 1");
const unresolved = await pool.query("SELECT count(*)::int AS count FROM conflicts WHERE status = 'pending'");
const counters = await pool.query("SELECT name, value FROM metrics_counters");
const lagRows = await pool.query("SELECT milliseconds FROM convergence_lags ORDER BY milliseconds");

const byPayment = new Map(finalStates.rows.map((row) => [row.payment_id, row.status]));
const missingOrWrong = payments.filter((payment) => byPayment.get(payment.paymentId) !== payment.finalStatus);
const counterObject = Object.fromEntries(counters.rows.map((r) => [r.name, Number(r.value)]));
const lags = lagRows.rows.map((r) => Number(r.milliseconds));
const duplicateSafeguardWorked = delivery.duplicated === 0 || (counterObject.duplicates_dropped ?? 0) >= delivery.duplicated;
const staleRegressions = await pool.query(
  `SELECT count(*)::int AS count
   FROM payment_decisions
   WHERE kind = 'applied'
     AND details->>'previous_status' IN ('succeeded', 'failed', 'cancelled')
     AND details->>'next_status' <> details->>'previous_status'`
);
const noTerminalRegression = Number(staleRegressions.rows[0].count) === 0;
const failed = [
  missingOrWrong.length === 0 ? null : `${missingOrWrong.length} payments did not converge`,
  effects.rowCount === 0 ? null : `${effects.rowCount} idempotency keys had duplicate effects`,
  Number(unresolved.rows[0].count) === 0 ? null : `${unresolved.rows[0].count} conflicts unresolved`,
  duplicateSafeguardWorked ? null : "duplicate delivery safeguard did not run",
  noTerminalRegression ? null : `${staleRegressions.rows[0].count} terminal regressions were applied`
].filter(Boolean);

const summary = {
  seed,
  payments: count,
  events_generated: payments.reduce((sum, payment) => sum + payment.events.length, 0),
  events_delivered: delivery.delivered.length,
  duplicated: delivery.duplicated,
  dropped: delivery.dropped,
  stale_or_conflict_injected: delivery.staleInjected,
  stale_ignored: counterObject.stale_events_ignored ?? 0,
  conflicts_detected: counterObject.conflicts_detected ?? 0,
  payments_repaired_by_sweeper: counterObject.payments_repaired_by_sweeper ?? 0,
  delivery_retries: counterObject.delivery_retries ?? 0,
  convergence_lag_ms_p50: percentile(lags, 0.5),
  convergence_lag_ms_p95: percentile(lags, 0.95),
  invariants: {
    final_state_matches_oracle: missingOrWrong.length === 0,
    state_never_regressed_from_terminal: noTerminalRegression,
    effects_at_most_once: effects.rowCount === 0,
    duplicate_safeguard_observed: duplicateSafeguardWorked,
    conflicts_visible_or_resolved: Number(unresolved.rows[0].count) === 0,
    transient_failures_not_lost: (counterObject.dead_letter_count ?? 0) === 0
  },
  failure_replay: `npm run chaos -- --seed=${seed} --payments=${count}`
};

console.log(JSON.stringify(summary, null, 2));
await pool.end();

if (failed.length > 0 && !expectFailure) {
  console.error(`Chaos failed for seed ${seed}: ${failed.join("; ")}`);
  process.exit(1);
}
if (failed.length === 0 && expectFailure) {
  console.error(`Expected failure did not occur for seed ${seed}`);
  process.exit(1);
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];
}
