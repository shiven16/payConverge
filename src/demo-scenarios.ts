import { config } from "./config.js";
import { pool } from "./db.js";
import { signedHeaders } from "./harness-utils.js";
import { PaymentStatus } from "./types.js";

const scenario = process.argv[2];
const baseUrl = process.env.DEMO_BASE_URL ?? `http://localhost:${config().port}`;
if (scenario !== "conflict" && scenario !== "outage") {
  throw new Error("Usage: npm run demo:scenario -- conflict|outage");
}

async function register(paymentId: string) {
  const response = await fetch(`${baseUrl}/payments/${encodeURIComponent(paymentId)}/register`, { method: "POST" });
  if (!response.ok) throw new Error(`Registration failed: ${response.status} ${await response.text()}`);
}

async function setAuthority(paymentId: string, status: PaymentStatus, updated: Date) {
  await pool.query(
    `INSERT INTO authority_payments(payment_id, status, provider_updated_at, payload)
     VALUES($1, $2, $3, $4)
     ON CONFLICT(payment_id) DO UPDATE SET status = EXCLUDED.status, provider_updated_at = EXCLUDED.provider_updated_at, payload = EXCLUDED.payload`,
    [paymentId, status, updated, { payment_id: paymentId, status }]
  );
}

async function send(paymentId: string, eventId: string, status: PaymentStatus, updated: Date, expectedStatus = 202) {
  const eventType = status === "succeeded" ? "payment_succeeded" : status === "failed" ? "payment_failed" : "payment_processing";
  const body = JSON.stringify({
    event_id: eventId,
    type: eventType,
    content: { object: { payment_id: paymentId, status, updated: updated.toISOString() } }
  });
  const response = await fetch(`${baseUrl}/webhooks/hyperswitch`, {
    method: "POST",
    headers: signedHeaders(body, config().webhookSigningKey),
    body
  });
  if (response.status !== expectedStatus) throw new Error(`Webhook returned ${response.status}; expected ${expectedStatus}: ${await response.text()}`);
  return response.status;
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean | Promise<boolean>, name: string): Promise<T> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (await ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${name}`);
}

async function runConflict() {
  const paymentId = `pay_conflict_${Date.now()}`;
  const failureTime = new Date(Date.now() - 1000);
  await register(paymentId);
  await setAuthority(paymentId, "failed", failureTime);
  await send(paymentId, `${paymentId}_failed`, "failed", failureTime);

  await setAuthority(paymentId, "succeeded", new Date());
  await send(paymentId, `${paymentId}_late_success`, "succeeded", new Date(failureTime.getTime() - 1000));

  const timeline = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/payments/${paymentId}/timeline`);
    return response.json() as Promise<any>;
  }, (value) => {
    const kinds = value.decisions.map((entry: any) => entry.kind);
    return kinds.includes("conflict_detected")
      && kinds.includes("verification_pulled")
      && value.commands.some((command: any) => command.command_type === "compensate_late_success" && command.status === "delivered");
  }, "late-success compensation delivery");
  console.log(JSON.stringify({
    scenario: "conflict",
    payment_id: paymentId,
    event_sequence: ["payment_failed", "payment_succeeded (late timestamp)"],
    final_status: timeline.payment.status,
    decisions: timeline.decisions.filter((entry: any) => ["conflict_detected", "verification_pulled", "command_emitted"].includes(entry.kind)),
    compensation: timeline.commands.filter((command: any) => command.command_type === "compensate_late_success")
  }, null, 2));
}

async function runOutage() {
  const paymentIds = Array.from({ length: 3 }, (_, index) => `pay_outage_${Date.now()}_${index}`);
  const now = new Date();
  for (const paymentId of paymentIds) {
    await register(paymentId);
  }
  await pool.query("UPDATE runtime_controls SET enabled = false WHERE control_name IN ('webhook_ingestion', 'recovery_sweeper')");
  let before: any;
  let repairsBefore = 0;
  try {
    for (const paymentId of paymentIds) {
      await setAuthority(paymentId, "succeeded", now);
      const status = await send(paymentId, `${paymentId}_outage_delivery`, "succeeded", now, 503);
      if (status !== 503) throw new Error("Expected the simulated outage to reject webhook ingestion");
    }
    await pool.query(
      `UPDATE payments SET updated_at = now() - (($1::int + 1) || ' seconds')::interval WHERE payment_id = ANY($2::text[])`,
      [config().stuckAfterSeconds, paymentIds]
    );
    const beforeResponse = await fetch(`${baseUrl}/metrics`);
    before = await beforeResponse.json() as any;
    repairsBefore = Number(before.counters.payments_repaired_by_sweeper ?? 0);
  } finally {
    await pool.query("UPDATE runtime_controls SET enabled = true WHERE control_name IN ('webhook_ingestion', 'recovery_sweeper')");
  }
  const after = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    return response.json() as Promise<any>;
  }, async (value) => {
    const states = await pool.query("SELECT count(*)::int AS count FROM payments WHERE payment_id = ANY($1::text[]) AND status = 'succeeded'", [paymentIds]);
    return value.payments_out_of_sync === 0 && states.rows[0].count === paymentIds.length;
  }, "sweeper outage repair");
  console.log(JSON.stringify({
    scenario: "outage-recovery",
    payment_ids: paymentIds,
    webhook_attempts_rejected: paymentIds.length,
    webhooks_accepted_during_outage: 0,
    webhook_redeliveries: 0,
    drift_before_sweep: before.payments_out_of_sync,
    drift_after_sweep: after.payments_out_of_sync,
    repaired_by_sweeper: Number(after.counters.payments_repaired_by_sweeper ?? 0) - repairsBefore,
    final_status: "succeeded"
  }, null, 2));
}

try {
  if (scenario === "conflict") await runConflict();
  else await runOutage();
} finally {
  await pool.end();
}
