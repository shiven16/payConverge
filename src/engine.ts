import pg from "pg";
import { authorityClient, AuthorityClient } from "./authority.js";
import { config } from "./config.js";
import { incMetric, tx } from "./db.js";
import { commandSpecs, isContradictoryTerminal, isImplausibleJump, isStale, isSupportedPaymentEvent, terminalStatuses } from "./state.js";
import { ExtractedEvent, HyperswitchWebhook, PaymentStatus } from "./types.js";

export async function ingestValidEvent(rawBody: string, payload: HyperswitchWebhook, event: ExtractedEvent) {
  return tx(async (client) => {
    const cfg = config();
    if (!event.eventId) throw new Error("event_id is required");

    if (!cfg.disableDedup) {
      const inserted = await client.query(
        `INSERT INTO webhook_events(event_id, event_type, payment_id, provider_updated_at, raw_body, payload)
         VALUES($1, $2, $3, $4, $5, $6)
         ON CONFLICT(event_id) DO NOTHING`,
        [event.eventId, event.eventType, event.paymentId, event.providerUpdatedAt, rawBody, payload]
      );
      if (inserted.rowCount === 0) {
        await client.query("UPDATE webhook_events SET duplicate_count = duplicate_count + 1 WHERE event_id = $1", [event.eventId]);
        await incMetric(client, "duplicates_dropped");
        if (event.paymentId) {
          await decision(client, event.paymentId, event.eventId, "duplicate", "Duplicate event_id acknowledged without reapplying");
        }
        return { duplicate: true };
      }
    } else {
      await client.query(
        `INSERT INTO webhook_events(event_id, event_type, payment_id, provider_updated_at, raw_body, payload)
         VALUES($1, $2, $3, $4, $5, $6)
         ON CONFLICT(event_id) DO UPDATE SET duplicate_count = webhook_events.duplicate_count + 1`,
        [`${event.eventId}:${Math.random()}`, event.eventType, event.paymentId, event.providerUpdatedAt, rawBody, payload]
      );
    }

    if (!event.paymentId || !event.status || !isSupportedPaymentEvent(event.eventType)) {
      if (event.paymentId) await decision(client, event.paymentId, event.eventId, "stored_unsupported", "Unsupported or incomplete event stored only");
      await incMetric(client, "unsupported_events_stored");
      return { storedOnly: true };
    }

    await applyPaymentEvent(client, event, authorityClient());
    return { applied: true };
  });
}

export async function applyPaymentEvent(client: pg.PoolClient, event: ExtractedEvent, authority: AuthorityClient) {
  if (!event.paymentId || !event.status) return;
  const locked = await client.query("SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE", [event.paymentId]);
  const current = locked.rows[0] as
    | { status: PaymentStatus; provider_updated_at: Date | null; conflict_pending: boolean }
    | undefined;

  if (current && isStale(current.provider_updated_at, event.providerUpdatedAt)) {
    await decision(client, event.paymentId, event.eventId, "stale_ignored", `Ignored stale ${event.status}; stored state is ${current.status}`, {
      current_updated_at: current.provider_updated_at,
      incoming_updated_at: event.providerUpdatedAt
    });
    await incMetric(client, "stale_events_ignored");
    return;
  }

  if (current && (isContradictoryTerminal(current.status, event.status) || isImplausibleJump(current.status, event.status))) {
    await recordConflict(client, event.paymentId, event.eventId, `${current.status} conflicted with incoming ${event.status}`);
    await verifyAndReconcile(client, event.paymentId, event.eventId, authority, current.status);
    return;
  }

  await setPaymentState(client, event.paymentId, event.status, event.providerUpdatedAt, current?.status ?? null, event.eventId, "applied", "Applied newest non-conflicting payment state");
}

export async function verifyAndReconcile(
  client: pg.PoolClient,
  paymentId: string,
  eventId: string | null,
  authority: AuthorityClient,
  previousStatus?: PaymentStatus
) {
  const authoritative = await authority.getPayment(paymentId, client);
  if (!authoritative) {
    await decision(client, paymentId, eventId, "verification_missing", "Authority lookup returned no payment; conflict left visible");
    await incMetric(client, "conflicts_flagged");
    return;
  }
  await setPaymentState(
    client,
    paymentId,
    authoritative.status,
    authoritative.providerUpdatedAt,
    previousStatus ?? null,
    eventId,
    "verification_pulled",
    `Authority resolved payment as ${authoritative.status}`
  );
  await client.query(
    "UPDATE conflicts SET status = 'resolved', authority_status = $2, resolved_at = now() WHERE payment_id = $1 AND status = 'pending'",
    [paymentId, authoritative.status]
  );
  await incMetric(client, "conflicts_resolved");
}

export async function setPaymentState(
  client: pg.PoolClient,
  paymentId: string,
  nextStatus: PaymentStatus,
  providerUpdatedAt: Date | null,
  previousStatus: PaymentStatus | null,
  eventId: string | null,
  kind: string,
  reason: string
) {
  await client.query(
    `INSERT INTO payments(payment_id, status, provider_updated_at, terminal, conflict_pending, authority_status, updated_at)
     VALUES($1, $2, $3, $4, false, $2, now())
     ON CONFLICT(payment_id) DO UPDATE
       SET status = EXCLUDED.status,
           provider_updated_at = EXCLUDED.provider_updated_at,
           terminal = EXCLUDED.terminal,
           conflict_pending = false,
           authority_status = EXCLUDED.authority_status,
           updated_at = now()`,
    [paymentId, nextStatus, providerUpdatedAt, terminalStatuses.has(nextStatus)]
  );
  await decision(client, paymentId, eventId, kind, reason, { previous_status: previousStatus, next_status: nextStatus });
  await incMetric(client, "events_applied");
  for (const command of commandSpecs(paymentId, previousStatus, nextStatus)) {
    await client.query(
      `INSERT INTO outbox_commands(payment_id, command_type, target, payload, idempotency_key, max_attempts)
       VALUES($1, $2, $3, $4, $5, $6)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [paymentId, command.commandType, command.target, command.payload, command.idempotencyKey, config().outboxMaxAttempts]
    );
    await decision(client, paymentId, eventId, "command_emitted", `Emitted ${command.commandType} for ${command.target}`, {
      idempotency_key: command.idempotencyKey
    });
  }
}

async function recordConflict(client: pg.PoolClient, paymentId: string, eventId: string, reason: string) {
  await client.query("UPDATE payments SET conflict_pending = true WHERE payment_id = $1", [paymentId]);
  await client.query("INSERT INTO conflicts(payment_id, event_id, reason) VALUES($1, $2, $3)", [paymentId, eventId, reason]);
  await decision(client, paymentId, eventId, "conflict_detected", reason);
  await incMetric(client, "conflicts_detected");
}

export async function decision(
  client: pg.PoolClient,
  paymentId: string,
  eventId: string | null,
  kind: string,
  reason: string,
  details: unknown = {}
) {
  await client.query("INSERT INTO payment_decisions(payment_id, event_id, kind, reason, details) VALUES($1, $2, $3, $4, $5)", [
    paymentId,
    eventId,
    kind,
    reason,
    details
  ]);
}
