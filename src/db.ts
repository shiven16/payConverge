import pg from "pg";
import { config } from "./config.js";
import { setTimeout as sleep } from "node:timers/promises";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config().databaseUrl });

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (attempt >= 2 || (code !== "40P01" && code !== "40001")) throw error;
      await sleep(10 + Math.floor(Math.random() * (25 * (attempt + 1))));
    } finally {
      client.release();
    }
  }
}

export async function incMetric(client: pg.PoolClient, name: string, by = 1): Promise<void> {
  await client.query(
    `INSERT INTO metrics_counters(name, value) VALUES($1, $2)
     ON CONFLICT(name) DO UPDATE SET value = metrics_counters.value + EXCLUDED.value`,
    [name, by]
  );
}
