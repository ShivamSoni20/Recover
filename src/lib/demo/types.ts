export type DemoState =
  | "EMPTY"
  | "ORDER_CREATED"
  | "WAITING_INITIAL_PAYMENT"
  | "PAYMENT_FAILED"
  | "DIAGNOSING"
  | "RECOVERY_PROPOSED"
  | "RECOVERY_AUTHORIZED"
  | "WAITING_APPROVAL"
  | "CREATING_RECOVERY_CHECKOUT"
  | "RECOVERY_CHECKOUT_READY"
  | "WAITING_RECOVERY_PAYMENT"
  | "PAYMENT_SUBMITTED"
  | "VERIFYING"
  | "RECOVERED_VERIFIED"
  | "MANUAL_REVIEW";

export type PaymentStatus = "CREATED" | "FAILED" | "CAPTURED" | "PENDING";

export interface GateCheck {
  id: string;
  label: string;
  answer: string;
  detail?: string;
  passed: boolean;
}

export interface VerificationCheck {
  id: string;
  label: string;
  result: string;
}

export interface DemoEvent {
  time: string;
  label: string;
}

export interface DemoCase {
  caseId: string;
  orderId: string;
  originalPaymentId: string;
  amountMinor: number;
  currency: "INR";
  paymentStatus: PaymentStatus;
  failureReason: string;
  failureDetail: string;
  method: string;
  failedAt: string | null;
  diagnosis: string;
  failureClass: string;
  confidence: number;
  recoveryStrategy: string;
  gateChecks: GateCheck[];
  recoveryReference: string;
  recoveryLinkId: string;
  recoveryPaymentId: string;
  verificationChecks: VerificationCheck[];
  state: DemoState;
  events: DemoEvent[];
  customer: { name: string; email: string; purpose: string };
  description: string;
}

export interface DemoStore {
  cases: DemoCase[];
  activeCaseId: string | null;
}

/** Explicit, allowed state transitions. No jumping from failure straight to verified. */
export const TRANSITIONS: Record<DemoState, DemoState[]> = {
  EMPTY: ["ORDER_CREATED"],
  ORDER_CREATED: ["WAITING_INITIAL_PAYMENT"],
  WAITING_INITIAL_PAYMENT: ["PAYMENT_FAILED"],
  PAYMENT_FAILED: ["DIAGNOSING"],
  DIAGNOSING: ["RECOVERY_PROPOSED"],
  RECOVERY_PROPOSED: ["RECOVERY_AUTHORIZED", "MANUAL_REVIEW"],
  RECOVERY_AUTHORIZED: ["WAITING_APPROVAL", "MANUAL_REVIEW"],
  WAITING_APPROVAL: ["CREATING_RECOVERY_CHECKOUT", "MANUAL_REVIEW"],
  CREATING_RECOVERY_CHECKOUT: ["RECOVERY_CHECKOUT_READY"],
  RECOVERY_CHECKOUT_READY: ["WAITING_RECOVERY_PAYMENT"],
  WAITING_RECOVERY_PAYMENT: ["PAYMENT_SUBMITTED"],
  PAYMENT_SUBMITTED: ["VERIFYING"],
  VERIFYING: ["RECOVERED_VERIFIED"],
  RECOVERED_VERIFIED: [],
  MANUAL_REVIEW: [],
};

export function canTransition(from: DemoState, to: DemoState) {
  return from === to || TRANSITIONS[from].includes(to);
}

export function formatINR(minor: number) {
  return "₹" + (minor / 100).toLocaleString("en-IN");
}
