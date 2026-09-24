import { pool } from "./db.js";
import { signWebhook } from "./signature.js";
import { HyperswitchWebhook, PaymentStatus } from "./types.js";

export type GeneratedPayment = {
  paymentId: string;
  finalStatus: PaymentStatus;
  events: HyperswitchWebhook[];
};

export function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function generatePayments(seed: number, count: number): GeneratedPayment[] {
  const random = rng(seed);
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const payments: GeneratedPayment[] = [];
  for (let i = 0; i < count; i++) {
    const paymentId = `pay_${seed}_${i}`;
    const succeeds = random() > 0.25;
    const statuses: PaymentStatus[] = succeeds ? ["processing", "authorized", "succeeded"] : ["processing", "failed"];
    const events = statuses.map((status, index) => webhook(paymentId, `evt_${seed}_${i}_${index}`, status, new Date(base + i * 10000 + index * 1000)));
    payments.push({ paymentId, finalStatus: statuses[statuses.length - 1], events });
  }
  return payments;
}

export function adversarialDelivery(seed: number, payments: GeneratedPayment[]) {
  const random = rng(seed ^ 0x9e3779b9);
  const delivered: HyperswitchWebhook[] = [];
  let duplicated = 0;
  let dropped = 0;
  let staleInjected = 0;
  for (const payment of payments) {
    for (const event of payment.events) {
      if (random() < 0.08) {
        dropped++;
        continue;
      }
      delivered.push(event);
      if (random() < 0.18) {
        delivered.push(event);
        duplicated++;
      }
    }
    if (random() < 0.06) {
      delivered.push(webhook(payment.paymentId, `evt_${seed}_${payment.paymentId}_late_conflict`, "succeeded", new Date("2026-01-01T00:00:00.500Z")));
      staleInjected++;
    }
  }
  delivered.sort(() => random() - 0.5);
  return { delivered, duplicated, dropped, staleInjected };
}

export function webhook(paymentId: string, eventId: string, status: PaymentStatus, updated: Date): HyperswitchWebhook {
  const type =
    status === "succeeded"
      ? "payment_succeeded"
      : status === "failed"
        ? "payment_failed"
        : status === "authorized"
          ? "payment_authorized"
          : "payment_processing";
  return {
    event_id: eventId,
    type,
    content: {
      object: {
        payment_id: paymentId,
        status,
        updated: updated.toISOString()
      }
    }
  };
}

export async function resetAll() {
  await pool.query(
    "TRUNCATE webhook_events, payments, payment_decisions, conflicts, outbox_commands, merchant_effects, authority_payments, metrics_counters, convergence_lags RESTART IDENTITY"
  );
}

export async function seedAuthority(payments: GeneratedPayment[]) {
  for (const payment of payments) {
    const finalEvent = payment.events[payment.events.length - 1];
    await pool.query(
      `INSERT INTO payments(payment_id, status, provider_updated_at, terminal, updated_at)
       VALUES($1, 'requires_payment_method', $2, false, now() - interval '1 hour')
       ON CONFLICT(payment_id) DO NOTHING`,
      [payment.paymentId, new Date(Date.parse(String(finalEvent.content?.object?.updated)) - 60_000).toISOString()]
    );
    await pool.query(
      "INSERT INTO authority_payments(payment_id, status, provider_updated_at, payload) VALUES($1, $2, $3, $4)",
      [
        payment.paymentId,
        payment.finalStatus,
        finalEvent.content?.object?.updated,
        { payment_id: payment.paymentId, status: payment.finalStatus }
      ]
    );
  }
}

export function signedHeaders(body: string, secret: string) {
  return { "content-type": "application/json", "x-webhook-signature-512": signWebhook(body, secret) };
}
