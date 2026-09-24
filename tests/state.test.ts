import { describe, expect, it } from "vitest";
import { extractEvent, isContradictoryTerminal, isStale } from "../src/state.js";

describe("state rules", () => {
  it("extracts Hyperswitch payment webhook fields", () => {
    const event = extractEvent({
      event_id: "evt_1",
      type: "payment_succeeded",
      content: { object: { payment_id: "pay_1", status: "succeeded", updated: "2026-01-01T00:00:00Z" } }
    });
    expect(event).toMatchObject({ eventId: "evt_1", eventType: "payment_succeeded", paymentId: "pay_1", status: "succeeded" });
    expect(event.providerUpdatedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("detects stale events by provider updated timestamp", () => {
    expect(isStale(new Date("2026-01-01T00:00:02Z"), new Date("2026-01-01T00:00:01Z"))).toBe(true);
    expect(isStale(new Date("2026-01-01T00:00:01Z"), new Date("2026-01-01T00:00:02Z"))).toBe(false);
  });

  it("detects contradictory terminal states", () => {
    expect(isContradictoryTerminal("failed", "succeeded")).toBe(true);
    expect(isContradictoryTerminal("processing", "succeeded")).toBe(false);
  });
});
