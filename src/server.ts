import Fastify from "fastify";
import { config } from "./config.js";
import { pool, tx } from "./db.js";
import { decision, ingestValidEvent, lockPayment } from "./engine.js";
import { extractEvent } from "./state.js";
import { verifyWebhookSignature } from "./signature.js";
import { HyperswitchWebhook } from "./types.js";
import { deliverDueCommands } from "./worker.js";
import { runSweeper } from "./sweeper.js";
import { retryDeadLetter } from "./worker.js";

export function buildServer() {
  const app = Fastify({ logger: true });
  const cfg = config();

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/healthz", async (_request, reply) => {
    await pool.query("SELECT 1");
    return reply.code(200).send({ status: "ok" });
  });

  app.post("/payments/:paymentId/register", async (request, reply) => {
    const { paymentId } = request.params as { paymentId: string };
    if (!paymentId.trim()) return reply.code(400).send({ error: "paymentId is required" });
    const created = await tx(async (client) => {
      await lockPayment(client, paymentId);
      const result = await client.query(
        `INSERT INTO payments(payment_id, status, terminal)
         VALUES($1, 'requires_payment_method', false)
         ON CONFLICT(payment_id) DO NOTHING
         RETURNING payment_id`,
        [paymentId]
      );
      if (result.rowCount) await decision(client, paymentId, null, "payment_registered", "Merchant payment intent registered for webhook recovery");
      return Boolean(result.rowCount);
    });
    return reply.code(created ? 201 : 200).send({ payment_id: paymentId, created });
  });

  app.post("/webhooks/hyperswitch", async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ""));
    const signature = request.headers["x-webhook-signature-512"];
    if (!verifyWebhookSignature(raw, cfg.webhookSigningKey, signature)) {
      return reply.code(401).send({ error: "invalid signature" });
    }
    const ingestion = await pool.query("SELECT enabled FROM runtime_controls WHERE control_name = 'webhook_ingestion'");
    if (ingestion.rows[0]?.enabled === false) return reply.code(503).send({ error: "webhook ingestion temporarily unavailable" });
    let payload: HyperswitchWebhook;
    try {
      payload = JSON.parse(raw.toString("utf8")) as HyperswitchWebhook;
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }
    await ingestValidEvent(raw.toString("utf8"), payload, extractEvent(payload));
    return reply.code(202).send({ ok: true });
  });

  app.get("/metrics", async () => {
    const counters = await pool.query("SELECT name, value FROM metrics_counters ORDER BY name");
    const depth = await pool.query("SELECT status, count(*)::int AS count FROM outbox_commands GROUP BY status");
    const lags = await pool.query("SELECT milliseconds FROM convergence_lags ORDER BY milliseconds");
    const drift = await pool.query(
      "SELECT count(*)::int AS count FROM payments p JOIN authority_payments a USING(payment_id) WHERE p.status IS DISTINCT FROM a.status"
    );
    const values = lags.rows.map((r) => Number(r.milliseconds));
    return {
      counters: Object.fromEntries(counters.rows.map((r) => [r.name, Number(r.value)])),
      outbox: Object.fromEntries(depth.rows.map((r) => [r.status, r.count])),
      payments_out_of_sync: drift.rows[0].count,
      convergence_lag_ms: { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
    };
  });

  if (cfg.runBackgroundProcesses) {
    const workerTimer = setInterval(() => {
      deliverDueCommands().catch((error) => app.log.error({ error }, "background worker iteration failed"));
    }, 1000);
    const sweeperTimer = setInterval(() => {
      runSweeper().catch((error) => app.log.error({ error }, "background sweeper iteration failed"));
    }, 5000);
    workerTimer.unref();
    sweeperTimer.unref();
    app.addHook("onClose", async () => {
      clearInterval(workerTimer);
      clearInterval(sweeperTimer);
    });
  }

  app.get("/payments/:paymentId/timeline", async (request) => {
    const { paymentId } = request.params as { paymentId: string };
    const payment = await pool.query("SELECT * FROM payments WHERE payment_id = $1", [paymentId]);
    const events = await pool.query(
      "SELECT event_id, event_type, provider_updated_at, received_at, duplicate_count FROM webhook_events WHERE payment_id = $1 ORDER BY received_at",
      [paymentId]
    );
    const decisions = await pool.query(
      "SELECT kind, event_id, reason, details, created_at FROM payment_decisions WHERE payment_id = $1 ORDER BY created_at",
      [paymentId]
    );
    const commands = await pool.query(
      "SELECT id, command_type, target, status, attempts, idempotency_key, last_error, created_at, delivered_at FROM outbox_commands WHERE payment_id = $1 ORDER BY id",
      [paymentId]
    );
    return { payment: payment.rows[0] ?? null, events: events.rows, decisions: decisions.rows, commands: commands.rows };
  });

  app.get("/dead-letters", async () => {
    const result = await pool.query("SELECT * FROM outbox_commands WHERE status = 'dead_letter' ORDER BY id");
    return result.rows;
  });

  app.post("/dead-letters/:id/retry", async (request) => {
    const { id } = request.params as { id: string };
    await retryDeadLetter(Number(id));
    return { ok: true };
  });

  return app;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  app.listen({ host: "0.0.0.0", port: config().port });
}
