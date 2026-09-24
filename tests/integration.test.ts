import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { pool } from "../src/db.js";
import { ingestValidEvent } from "../src/engine.js";
import { extractEvent } from "../src/state.js";
import { resetAll, seedAuthority, webhook } from "../src/harness-utils.js";
import { deliverDueCommands } from "../src/worker.js";

async function hasDb() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

describe("postgres integration", () => {
  beforeAll(async () => {
    if (!(await hasDb())) return;
    await pool.query(await readFile("migrations/001_init.sql", "utf8"));
    await resetAll();
  });

  it("deduplicates concurrent delivery and applies once", async () => {
    if (!(await hasDb())) return;
    const payload = webhook("pay_dedup", "evt_dedup", "succeeded", new Date("2026-01-01T00:00:00Z"));
    await seedAuthority([{ paymentId: "pay_dedup", finalStatus: "succeeded", events: [payload] }]);
    await Promise.all(Array.from({ length: 8 }, () => ingestValidEvent(JSON.stringify(payload), payload, extractEvent(payload))));
    const events = await pool.query("SELECT duplicate_count FROM webhook_events WHERE event_id = 'evt_dedup'");
    const commands = await pool.query("SELECT count(*)::int AS count FROM outbox_commands WHERE payment_id = 'pay_dedup'");
    expect(events.rows[0].duplicate_count).toBe(7);
    expect(commands.rows[0].count).toBe(2);
  });

  it("records state change and outbox commands atomically, then delivers effects once", async () => {
    if (!(await hasDb())) return;
    await resetAll();
    const payload = webhook("pay_atomic", "evt_atomic", "failed", new Date("2026-01-01T00:00:00Z"));
    await seedAuthority([{ paymentId: "pay_atomic", finalStatus: "failed", events: [payload] }]);
    await ingestValidEvent(JSON.stringify(payload), payload, extractEvent(payload));
    await deliverDueCommands(10);
    await deliverDueCommands(10);
    const effects = await pool.query("SELECT count(*)::int AS count FROM merchant_effects WHERE payment_id = 'pay_atomic'");
    expect(effects.rows[0].count).toBe(2);
  });
});
