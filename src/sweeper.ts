import { setTimeout as sleep } from "node:timers/promises";
import { authorityClient } from "./authority.js";
import { config } from "./config.js";
import { incMetric, pool, tx } from "./db.js";
import { verifyAndReconcile } from "./engine.js";

export async function runSweeper(limit = 100): Promise<number> {
  const cfg = config();
  return tx(async (client) => {
    const control = await client.query("SELECT enabled FROM runtime_controls WHERE control_name = 'recovery_sweeper'");
    if (control.rows[0]?.enabled === false) return 0;
    const candidates = await client.query(
      `SELECT payment_id, status
       FROM payments
       WHERE conflict_pending = true
          OR (terminal = false AND updated_at < now() - ($1 || ' seconds')::interval)
          OR EXISTS (
            SELECT 1 FROM authority_payments a
            WHERE a.payment_id = payments.payment_id AND a.status IS DISTINCT FROM payments.status
          )
       ORDER BY updated_at
       LIMIT $2`,
      [cfg.stuckAfterSeconds, limit]
    );
    let repaired = 0;
    for (const candidate of candidates.rows) {
      const claimed = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked", [candidate.payment_id]);
      if (!claimed.rows[0].locked) continue;
      const current = await client.query(
        `SELECT payment_id, status, conflict_pending
         FROM payments
         WHERE payment_id = $1
           AND (
             conflict_pending = true
             OR (terminal = false AND updated_at < now() - ($2 || ' seconds')::interval)
             OR EXISTS (
               SELECT 1 FROM authority_payments a
               WHERE a.payment_id = payments.payment_id AND a.status IS DISTINCT FROM payments.status
             )
           )
         FOR UPDATE`,
        [candidate.payment_id, cfg.stuckAfterSeconds]
      );
      if (current.rowCount === 0) continue;
      const changed = await verifyAndReconcile(client, candidate.payment_id, null, authorityClient(), current.rows[0].status);
      if (changed || current.rows[0].conflict_pending) {
        await incMetric(client, "payments_repaired_by_sweeper");
        repaired++;
      }
    }
    return repaired;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const once = process.argv.includes("--once");
  do {
    const count = await runSweeper();
    if (once) break;
    if (count === 0) await sleep(5000);
  } while (true);
  await pool.end();
}
