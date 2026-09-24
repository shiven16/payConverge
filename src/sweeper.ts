import { setTimeout as sleep } from "node:timers/promises";
import { authorityClient } from "./authority.js";
import { config } from "./config.js";
import { incMetric, pool, tx } from "./db.js";
import { verifyAndReconcile } from "./engine.js";

export async function runSweeper(limit = 100): Promise<number> {
  const cfg = config();
  return tx(async (client) => {
    const result = await client.query(
      `SELECT payment_id, status
       FROM payments
       WHERE conflict_pending = true
          OR terminal = false
          OR updated_at < now() - ($1 || ' seconds')::interval
       ORDER BY updated_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [cfg.stuckAfterSeconds, limit]
    );
    for (const row of result.rows) {
      await verifyAndReconcile(client, row.payment_id, null, authorityClient(), row.status);
      await incMetric(client, "payments_repaired_by_sweeper");
    }
    return result.rowCount ?? 0;
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
