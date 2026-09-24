import crypto from "node:crypto";

export function signWebhook(rawBody: string | Buffer, secret: string): string {
  return crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(rawBody: string | Buffer, secret: string, signature: unknown): boolean {
  if (typeof signature !== "string" || signature.length === 0) return false;
  const expected = signWebhook(rawBody, secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
