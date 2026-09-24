export type Config = {
  databaseUrl: string;
  port: number;
  webhookSigningKey: string;
  authorityMode: "mock" | "hyperswitch";
  hyperswitchBaseUrl: string;
  hyperswitchApiKey: string;
  stuckAfterSeconds: number;
  outboxMaxAttempts: number;
  disableDedup: boolean;
};

export function config(): Config {
  return {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/convergence",
    port: Number(process.env.PORT ?? 3000),
    webhookSigningKey: process.env.WEBHOOK_SIGNING_KEY ?? "dev_webhook_secret",
    authorityMode: (process.env.AUTHORITY_MODE ?? "mock") as "mock" | "hyperswitch",
    hyperswitchBaseUrl: process.env.HYPERSWITCH_BASE_URL ?? "https://sandbox.hyperswitch.io",
    hyperswitchApiKey: process.env.HYPERSWITCH_API_KEY ?? "",
    stuckAfterSeconds: Number(process.env.STUCK_AFTER_SECONDS ?? 900),
    outboxMaxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 5),
    disableDedup: process.env.DISABLE_DEDUP === "1"
  };
}
