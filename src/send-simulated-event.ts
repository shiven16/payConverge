import { config } from "./config.js";
import { signedHeaders, webhook } from "./harness-utils.js";

const paymentId = process.argv[2] ?? `pay_demo_${Date.now()}`;
const status = (process.argv[3] ?? "succeeded") as "processing" | "authorized" | "succeeded" | "failed";
const payload = webhook(paymentId, `evt_demo_${Date.now()}`, status, new Date());
const body = JSON.stringify(payload);
const response = await fetch(`http://localhost:${config().port}/webhooks/hyperswitch`, {
  method: "POST",
  headers: signedHeaders(body, config().webhookSigningKey),
  body
});
console.log({ status: response.status, body: await response.text(), paymentId });
