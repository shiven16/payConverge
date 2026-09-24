import { describe, expect, it } from "vitest";
import { extractEvent, isContradictoryTerminal, isSupportedPaymentEvent, transitionDecision } from "../src/state.js";

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

  it("uses explicit monotonic transitions when timestamps tie or status moves backward", () => {
    const sameTime = new Date("2026-01-01T00:00:02Z");
    expect(transitionDecision("processing", "authorized", sameTime, sameTime)).toBe("apply");
    expect(transitionDecision("authorized", "processing", sameTime, sameTime)).toBe("stale");
    expect(transitionDecision("authorized", "processing", sameTime, new Date("2026-01-01T00:00:03Z"))).toBe("stale");
  });

  it("detects contradictory terminal states", () => {
    expect(isContradictoryTerminal("failed", "succeeded")).toBe(true);
    expect(isContradictoryTerminal("processing", "succeeded")).toBe(false);
    expect(transitionDecision("failed", "succeeded", new Date("2026-01-01T00:00:02Z"), new Date("2026-01-01T00:00:01Z"))).toBe("conflict");
  });

  it("never reopens a terminal payment for a newer nonterminal event", () => {
    expect(transitionDecision("failed", "processing", new Date("2026-01-01T00:00:01Z"), new Date("2026-01-01T00:00:09Z"))).toBe("terminal_regression");
  });

  it("stores unlisted event types such as payment_expired without applying them", () => {
    expect(isSupportedPaymentEvent("payment_expired")).toBe(false);
  });
});
