import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { config } from "./config.js";
import { incMetric, pool, tx } from "./db.js";
import { decision } from "./engine.js";

export async function deliverDueCommands(limit = 25): Promise<number> {
  return tx(async (client) => {
    const result = await client.query(
      `SELECT * FROM outbox_commands
       WHERE status IN ('pending', 'retry') AND next_attempt_at <= now()
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    const metricIncrements = new Map<string, number>();
    for (const command of result.rows) {
      const metric = await deliverOne(client, command);
      if (metric) metricIncrements.set(metric, (metricIncrements.get(metric) ?? 0) + 1);
    }
    for (const [name, increment] of [...metricIncrements].sort(([left], [right]) => left.localeCompare(right))) {
      await incMetric(client, name, increment);
    }
    return result.rowCount ?? 0;
  });
}

async function deliverOne(client: pg.PoolClient, command: pg.QueryResultRow): Promise<string | null> {
  try {
    await mockMerchantConsumer(client, command);
    await client.query("UPDATE outbox_commands SET status = 'delivered', delivered_at = now(), last_error = null WHERE id = $1", [command.id]);
    await decision(client, command.payment_id, null, "command_delivered", `Delivered ${command.command_type} to ${command.target}`, {
      idempotency_key: command.idempotency_key
    });
    const eventTime = await client.query("SELECT provider_updated_at FROM payments WHERE payment_id = $1", [command.payment_id]);
    const providerUpdatedAt = eventTime.rows[0]?.provider_updated_at;
    if (providerUpdatedAt) {
      await client.query("INSERT INTO convergence_lags(payment_id, milliseconds) VALUES($1, $2)", [
        command.payment_id,
        Date.now() - new Date(providerUpdatedAt).getTime()
      ]);
    }
    return null;
  } catch (error) {
    const attempts = Number(command.attempts) + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempts >= Number(command.max_attempts)) {
      await client.query("UPDATE outbox_commands SET status = 'dead_letter', attempts = $2, last_error = $3 WHERE id = $1", [
        command.id,
        attempts,
        message
      ]);
      await decision(client, command.payment_id, null, "command_dead_lettered", message, { idempotency_key: command.idempotency_key });
      return "dead_letter_count";
    } else {
      const jitterMs = Math.floor(Math.random() * 250);
      const delaySeconds = Math.min(60, 2 ** attempts) + jitterMs / 1000;
      await client.query(
        `UPDATE outbox_commands
         SET status = 'retry', attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' seconds')::interval
         WHERE id = $1`,
        [command.id, attempts, message, delaySeconds]
      );
      await decision(client, command.payment_id, null, "command_retry", message, { attempts, idempotency_key: command.idempotency_key });
      return "delivery_retries";
    }
  }
}

async function mockMerchantConsumer(client: pg.PoolClient, command: pg.QueryResultRow) {
  const envName =
    command.target === "orders"
      ? "ORDER_SERVICE_MODE"
      : command.target === "inventory"
        ? "INVENTORY_SERVICE_MODE"
        : "NOTIFIER_SERVICE_MODE";
  const mode = process.env[envName] ?? "ok";
  if (mode === "down" || mode === "error") throw new Error(`${command.target} service configured ${mode}`);
  if (mode === "slow") await sleep(200);
  await client.query(
    `INSERT INTO merchant_effects(target, idempotency_key, command_type, payment_id, payload)
     VALUES($1, $2, $3, $4, $5)
     ON CONFLICT(idempotency_key) DO NOTHING`,
    [command.target, command.idempotency_key, command.command_type, command.payment_id, command.payload]
  );
}

export async function retryDeadLetter(id: number) {
  await pool.query("UPDATE outbox_commands SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null WHERE id = $1", [id]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const once = process.argv.includes("--once");
  do {
    const count = await deliverDueCommands();
    if (once) break;
    if (count === 0) await sleep(1000);
  } while (true);
  await pool.end();
}
