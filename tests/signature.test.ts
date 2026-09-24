import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../src/signature.js";

describe("signature verification", () => {
  it("accepts valid HMAC-SHA512 signatures and rejects tampering", () => {
    const body = JSON.stringify({ event_id: "evt_1" });
    const signature = signWebhook(body, "secret");
    expect(verifyWebhookSignature(body, "secret", signature)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, "secret", signature)).toBe(false);
    expect(verifyWebhookSignature(body, "wrong", signature)).toBe(false);
  });
});
