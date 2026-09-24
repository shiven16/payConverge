import pg from "pg";
import { config } from "./config.js";
import { PaymentStatus } from "./types.js";

export type AuthoritativePayment = {
  paymentId: string;
  status: PaymentStatus;
  providerUpdatedAt: Date;
  payload: unknown;
};

export interface AuthorityClient {
  getPayment(paymentId: string, client?: pg.PoolClient): Promise<AuthoritativePayment | null>;
}

export class MockAuthority implements AuthorityClient {
  async getPayment(paymentId: string, client?: pg.PoolClient): Promise<AuthoritativePayment | null> {
    if (!client) throw new Error("MockAuthority requires a database client");
    const result = await client.query(
      "SELECT payment_id, status, provider_updated_at, payload FROM authority_payments WHERE payment_id = $1",
      [paymentId]
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      paymentId: row.payment_id,
      status: row.status,
      providerUpdatedAt: row.provider_updated_at,
      payload: row.payload
    };
  }
}

export class HyperswitchAuthority implements AuthorityClient {
  async getPayment(paymentId: string): Promise<AuthoritativePayment | null> {
    const cfg = config();
    if (!cfg.hyperswitchApiKey) throw new Error("HYPERSWITCH_API_KEY is required for real authority mode");
    const response = await fetch(`${cfg.hyperswitchBaseUrl}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { "api-key": cfg.hyperswitchApiKey }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Hyperswitch retrieve failed: ${response.status}`);
    const body = (await response.json()) as { payment_id?: string; status?: PaymentStatus; modified_at?: string; created?: string };
    if (!body.payment_id || !body.status) return null;
    return {
      paymentId: body.payment_id,
      status: body.status,
      providerUpdatedAt: new Date(body.modified_at ?? body.created ?? new Date().toISOString()),
      payload: body
    };
  }
}

export function authorityClient(): AuthorityClient {
  return config().authorityMode === "hyperswitch" ? new HyperswitchAuthority() : new MockAuthority();
}
