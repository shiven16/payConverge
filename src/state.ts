import { ExtractedEvent, HyperswitchWebhook, PaymentStatus } from "./types.js";

export const terminalStatuses = new Set<PaymentStatus>(["succeeded", "failed", "cancelled"]);

const statusOrder: Record<PaymentStatus, number> = {
  requires_payment_method: 0,
  requires_confirmation: 1,
  requires_customer_action: 2,
  requires_merchant_action: 3,
  processing: 4,
  authorized: 5,
  partially_captured: 6,
  succeeded: 7,
  failed: 7,
  cancelled: 7
};

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
  return Object.hasOwn(eventStatus, eventType);
}

export type TransitionDecision = "apply" | "stale" | "terminal_regression" | "conflict";

export function transitionDecision(
  current: PaymentStatus | null,
  incoming: PaymentStatus,
  currentUpdated: Date | null,
  incomingUpdated: Date | null
): TransitionDecision {
  if (!current) return "apply";
  if (terminalStatuses.has(current)) {
    if (terminalStatuses.has(incoming) && current !== incoming) return "conflict";
    if (!terminalStatuses.has(incoming)) return "terminal_regression";
  }
  if (terminalStatuses.has(current) && current === incoming) {
    return incomingUpdated && currentUpdated && incomingUpdated.getTime() < currentUpdated.getTime() ? "stale" : "apply";
  }
  if (incomingUpdated && currentUpdated && incomingUpdated.getTime() < currentUpdated.getTime()) return "stale";
  if (statusOrder[incoming] < statusOrder[current]) return "stale";
  if (terminalStatuses.has(current) && terminalStatuses.has(incoming) && current !== incoming) return "conflict";
  return "apply";
}

export function isContradictoryTerminal(current: PaymentStatus, incoming: PaymentStatus): boolean {
  return terminalStatuses.has(current) && terminalStatuses.has(incoming) && current !== incoming;
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
      spec(paymentId, "cancel_order", "orders"),
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
