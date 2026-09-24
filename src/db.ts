import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config().databaseUrl });

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function incMetric(client: pg.PoolClient, name: string, by = 1): Promise<void> {
  await client.query(
    `INSERT INTO metrics_counters(name, value) VALUES($1, $2)
     ON CONFLICT(name) DO UPDATE SET value = metrics_counters.value + EXCLUDED.value`,
    [name, by]
  );
}
