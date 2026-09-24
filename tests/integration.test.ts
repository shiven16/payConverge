import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { pool } from "../src/db.js";
import { ingestValidEvent } from "../src/engine.js";
import { runSweeper } from "../src/sweeper.js";
import { extractEvent } from "../src/state.js";
import { resetAll, seedAuthority, webhook } from "../src/harness-utils.js";
import { deliverDueCommands } from "../src/worker.js";

const skipDb = process.env.SKIP_DB_TESTS === "1";

describe.skipIf(skipDb)("Postgres integration", () => {
  beforeAll(async () => {
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      throw new Error(`Postgres integration tests require DATABASE_URL to be reachable (or set SKIP_DB_TESTS=1): ${String(error)}`);
    }
    await pool.query(await readFile("migrations/001_init.sql", "utf8"));
    await resetAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("deduplicates concurrent event_id delivery and applies exactly once", async () => {
    await resetAll();
    const payload = webhook("pay_dedup", "evt_dedup", "succeeded", new Date("2026-01-01T00:00:00Z"));
    await seedAuthority([{ paymentId: "pay_dedup", finalStatus: "succeeded", events: [payload] }]);
    await Promise.all(Array.from({ length: 8 }, () => ingestValidEvent(JSON.stringify(payload), payload, extractEvent(payload))));

    const events = await pool.query("SELECT duplicate_count FROM webhook_events WHERE event_id = 'evt_dedup'");
    const applied = await pool.query("SELECT count(*)::int AS count FROM payment_decisions WHERE event_id = 'evt_dedup' AND kind = 'applied'");
    expect(events.rows[0].duplicate_count).toBe(7);
    expect(applied.rows[0].count).toBe(1);
  });

  it("serializes concurrent first events for a payment", async () => {
    await resetAll();
    const later = webhook("pay_first_race", "evt_race_success", "succeeded", new Date("2026-01-01T00:00:02Z"));
    const earlier = webhook("pay_first_race", "evt_race_processing", "processing", new Date("2026-01-01T00:00:01Z"));
    await Promise.all([later, earlier].map((event) => ingestValidEvent(JSON.stringify(event), event, extractEvent(event))));
    const payment = await pool.query("SELECT status FROM payments WHERE payment_id = 'pay_first_race'");
    expect(payment.rows[0].status).toBe("succeeded");
  });

  it("stores unsupported payment events without changing payment state", async () => {
    await resetAll();
    const payload = {
      event_id: "evt_expired",
      type: "payment_expired",
      content: { object: { payment_id: "pay_expired", status: "failed", updated: "2026-01-01T00:00:00Z" } }
    };
    await ingestValidEvent(JSON.stringify(payload), payload, extractEvent(payload));
    const rows = await pool.query(
      `SELECT (SELECT count(*)::int FROM webhook_events WHERE event_id = 'evt_expired') AS events,
              (SELECT count(*)::int FROM payments WHERE payment_id = 'pay_expired') AS payments`
    );
    expect(rows.rows[0]).toEqual({ events: 1, payments: 0 });
  });

  it("rolls back the payment and event when command insertion fails mid-transaction", async () => {
    await resetAll();
    const payload = webhook("pay_rollback", "evt_rollback", "failed", new Date("2026-01-01T00:00:00Z"));
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payment_id = 'pay_rollback' THEN RAISE EXCEPTION 'injected outbox failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_test_outbox BEFORE INSERT ON outbox_commands
      FOR EACH ROW EXECUTE FUNCTION fail_test_outbox_insert()
    `);
    try {
      await expect(ingestValidEvent(JSON.stringify(payload), payload, extractEvent(payload))).rejects.toThrow("injected outbox failure");
      const persisted = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM webhook_events WHERE event_id = 'evt_rollback') AS events,
          (SELECT count(*)::int FROM payments WHERE payment_id = 'pay_rollback') AS payments,
          (SELECT count(*)::int FROM outbox_commands WHERE payment_id = 'pay_rollback') AS commands`
      );
      expect(persisted.rows[0]).toEqual({ events: 0, payments: 0, commands: 0 });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS fail_test_outbox ON outbox_commands");
      await pool.query("DROP FUNCTION IF EXISTS fail_test_outbox_insert()");
    }
  });

  it("lets concurrent workers deliver every command effect once", async () => {
    await resetAll();
    const payload = webhook("pay_workers", "evt_workers", "succeeded", new Date("2026-01-01T00:00:00Z"));
    await ingestValidEvent(JSON.stringify(payload), payload, extractEvent(payload));
    const previousMode = process.env.NOTIFIER_SERVICE_MODE;
    process.env.NOTIFIER_SERVICE_MODE = "slow";
    try {
      await Promise.all(Array.from({ length: 8 }, () => deliverDueCommands(10)));
    } finally {
      if (previousMode === undefined) delete process.env.NOTIFIER_SERVICE_MODE;
      else process.env.NOTIFIER_SERVICE_MODE = previousMode;
    }
    const counts = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM outbox_commands WHERE payment_id = 'pay_workers' AND status = 'delivered') AS delivered,
        (SELECT count(*)::int FROM merchant_effects WHERE payment_id = 'pay_workers') AS effects,
        (SELECT count(DISTINCT idempotency_key)::int FROM merchant_effects WHERE payment_id = 'pay_workers') AS unique_effects`
    );
    expect(counts.rows[0]).toEqual({ delivered: 2, effects: 2, unique_effects: 2 });
  });

  it("serializes two sweepers with live ingestion and repairs to authority", async () => {
    await resetAll();
    const authoritative = webhook("pay_sweeper_race", "evt_authority", "succeeded", new Date("2026-01-01T00:00:10Z"));
    await seedAuthority([{ paymentId: "pay_sweeper_race", finalStatus: "succeeded", events: [authoritative] }]);
    const live = webhook("pay_sweeper_race", "evt_live", "processing", new Date("2026-01-01T00:00:09Z"));
    await Promise.all([
      runSweeper(10),
      runSweeper(10),
      ingestValidEvent(JSON.stringify(live), live, extractEvent(live))
    ]);
    for (let attempt = 0; attempt < 3; attempt++) await runSweeper(10);
    const payment = await pool.query("SELECT status FROM payments WHERE payment_id = 'pay_sweeper_race'");
    const duplicateCommands = await pool.query(
      "SELECT count(*)::int AS count FROM (SELECT idempotency_key FROM outbox_commands GROUP BY idempotency_key HAVING count(*) > 1) duplicates"
    );
    expect(payment.rows[0].status).toBe("succeeded");
    expect(duplicateCommands.rows[0].count).toBe(0);
  });

  it("records a terminal conflict first discovered by the recovery sweeper", async () => {
    await resetAll();
    const failedAuthority = webhook("pay_sweeper_conflict", "evt_authority_failed", "failed", new Date("2026-01-01T00:00:10Z"));
    await seedAuthority([{ paymentId: "pay_sweeper_conflict", finalStatus: "failed", events: [failedAuthority] }]);
    const lateSuccess = webhook("pay_sweeper_conflict", "evt_local_success", "succeeded", new Date("2026-01-01T00:00:11Z"));
    await ingestValidEvent(JSON.stringify(lateSuccess), lateSuccess, extractEvent(lateSuccess));
    await runSweeper(10);
    const result = await pool.query(
      `SELECT p.status, c.status AS conflict_status,
              EXISTS(SELECT 1 FROM payment_decisions d WHERE d.payment_id = p.payment_id AND d.kind = 'conflict_detected') AS detected,
              EXISTS(SELECT 1 FROM payment_decisions d WHERE d.payment_id = p.payment_id AND d.kind = 'verification_pulled') AS pulled
       FROM payments p JOIN conflicts c USING(payment_id) WHERE p.payment_id = 'pay_sweeper_conflict'`
    );
    expect(result.rows[0]).toEqual({ status: "failed", conflict_status: "resolved", detected: true, pulled: true });
  });
});
