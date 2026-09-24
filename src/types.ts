export type PaymentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_customer_action"
  | "requires_merchant_action"
  | "processing"
  | "authorized"
  | "partially_captured"
  | "succeeded"
  | "failed"
  | "cancelled";

export type HyperswitchWebhook = {
  event_id: string;
  type?: string;
  event_type?: string;
  content?: {
    object?: {
      payment_id?: string;
      id?: string;
      status?: string;
      updated?: string;
      modified_at?: string;
      created?: string;
      [key: string]: unknown;
    };
  };
  [key: string]: unknown;
};

export type ExtractedEvent = {
  eventId: string;
  eventType: string;
  paymentId: string | null;
  status: PaymentStatus | null;
  providerUpdatedAt: Date | null;
};
