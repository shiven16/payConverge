import { ExtractedEvent, HyperswitchWebhook, PaymentStatus } from "./types.js";

export const terminalStatuses = new Set<PaymentStatus>(["succeeded", "failed", "cancelled"]);

const eventStatus: Record<string, PaymentStatus> = {
  payment_succeeded: "succeeded",
  payment_failed: "failed",
  payment_processing: "processing",
  payment_cancelled: "cancelled",
  payment_authorized: "authorized",
  payment_captured: "succeeded",
  action_required: "requires_customer_action"
};

const knownStatuses = new Set<PaymentStatus>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_customer_action",
  "requires_merchant_action",
  "processing",
  "authorized",
  "partially_captured",
  "succeeded",
  "failed",
  "cancelled"
]);

export function extractEvent(payload: HyperswitchWebhook): ExtractedEvent {
  const eventType = String(payload.type ?? payload.event_type ?? "unknown");
  const object = payload.content?.object;
  const rawStatus = typeof object?.status === "string" ? object.status : eventStatus[eventType];
  const updated = object?.updated ?? object?.modified_at ?? object?.created;
  return {
    eventId: String(payload.event_id ?? ""),
    eventType,
    paymentId: typeof object?.payment_id === "string" ? object.payment_id : typeof object?.id === "string" ? object.id : null,
    status: rawStatus && knownStatuses.has(rawStatus as PaymentStatus) ? (rawStatus as PaymentStatus) : null,
    providerUpdatedAt: typeof updated === "string" ? new Date(updated) : null
  };
}

export function isSupportedPaymentEvent(eventType: string): boolean {
  return eventType in eventStatus || eventType.startsWith("payment_") || eventType === "action_required";
}

export function isStale(currentUpdated: Date | null, incomingUpdated: Date | null): boolean {
  if (!currentUpdated || !incomingUpdated) return false;
  return incomingUpdated.getTime() < currentUpdated.getTime();
}

export function isContradictoryTerminal(current: PaymentStatus, incoming: PaymentStatus): boolean {
  return terminalStatuses.has(current) && terminalStatuses.has(incoming) && current !== incoming;
}

export function isImplausibleJump(current: PaymentStatus, incoming: PaymentStatus): boolean {
  if (current === "succeeded" && incoming !== "succeeded") return true;
  if (current === "cancelled" && incoming === "authorized") return true;
  return false;
}

export function commandSpecs(paymentId: string, previous: PaymentStatus | null, next: PaymentStatus) {
  if (next === "succeeded" && previous === "failed") {
    return [
      spec(paymentId, "compensate_late_success", "orders"),
      spec(paymentId, "notify_late_success", "notifier")
    ];
  }
  if (next === "succeeded" && previous !== "succeeded") {
    return [
      spec(paymentId, "fulfil_order", "orders"),
      spec(paymentId, "notify_success", "notifier")
    ];
  }
  if ((next === "failed" || next === "cancelled") && previous !== next) {
    return [
      spec(paymentId, "release_stock", "inventory"),
      spec(paymentId, "notify_failure", "notifier")
    ];
  }
  return [];
}

function spec(paymentId: string, commandType: string, target: string) {
  return {
    paymentId,
    commandType,
    target,
    idempotencyKey: `${paymentId}:${commandType}:${target}`,
    payload: { payment_id: paymentId, command_type: commandType }
  };
}
