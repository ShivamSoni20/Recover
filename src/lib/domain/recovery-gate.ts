import crypto from "crypto";

export type GateReasonCode =
  | "PASS_TEST_MODE"
  | "PASS_ORIGINAL_UNPAID"
  | "PASS_NO_CAPTURED_SIBLING"
  | "PASS_ATTEMPT_LIMIT"
  | "PASS_STRATEGY_ALLOWED"
  | "PASS_AMOUNT_BOUND"
  | "PASS_CONFIDENCE_MET"
  | "DENY_NOT_TEST_MODE"
  | "DENY_ALREADY_PAID"
  | "DENY_CAPTURED_SIBLING"
  | "DENY_ACTIVE_RECOVERY_LINK"
  | "DENY_ATTEMPT_LIMIT_EXCEEDED"
  | "DENY_STRATEGY_NOT_ALLOWED"
  | "DENY_RISK_FAILURE"
  | "DENY_UNKNOWN_FAILURE"
  | "DENY_LOW_CONFIDENCE"
  | "DENY_AMOUNT_LIMIT_EXCEEDED"
  | "DENY_CURRENCY_MISMATCH";

export interface GateCheckResult {
  id: string;
  label: string;
  answer: string;
  detail?: string;
  passed: boolean;
}

export interface RecoveryGateInput {
  isTestMode: boolean;
  canonicalPayment: {
    id: string;
    amountMinor: number;
    currency: string;
    status: string;
    captured: boolean;
    errorCode?: string | null;
  };
  canonicalOrder?: {
    id: string;
    amountMinor: number;
    amountPaidMinor: number;
    amountDueMinor: number;
    currency?: string;
    status: string;
  };
  orderPayments?: Array<{
    id: string;
    status: string;
    captured: boolean;
    amountMinor: number;
  }>;
  existingActiveAction?: {
    id: string;
    status: string;
  };
  attemptCount: number;
  failureClass: string;
  confidence: number;
  proposedStrategy: string;
  policy: {
    maxRecoveryAttempts: number;
    maxAutonomousAmountMinor: number;
    requireApprovalAboveMinor: number;
    allowFreshCheckout: boolean;
    minDiagnosisConfidence: number;
    blockRiskOrPolicyFailures: boolean;
    blockUnknownFailures: boolean;
  };
}

export interface RecoveryGateOutput {
  authorized: boolean;
  requiresApproval: boolean;
  exactAmountMinor: number;
  currency: string;
  reasonCodes: GateReasonCode[];
  gateChecks: GateCheckResult[];
}

/**
 * Deterministic Recovery Gate.
 * THIS MODULE DOES NOT CALL THE LLM.
 * Strictly verifies provider facts and business policy boundaries.
 */
export function evaluateRecoveryGate(input: RecoveryGateInput): RecoveryGateOutput {
  const reasonCodes: GateReasonCode[] = [];
  const gateChecks: GateCheckResult[] = [];
  let authorized = true;

  // 1. Test Mode Check
  if (!input.isTestMode) {
    authorized = false;
    reasonCodes.push("DENY_NOT_TEST_MODE");
    gateChecks.push({
      id: "test_mode",
      label: "Test Mode verified?",
      answer: "NO",
      passed: false,
    });
  } else {
    reasonCodes.push("PASS_TEST_MODE");
    gateChecks.push({
      id: "test_mode",
      label: "Test Mode verified?",
      answer: "YES",
      passed: true,
    });
  }

  // 2. Currency Relationship Check (Compare Order and Payment currencies when both present)
  if (
    input.canonicalOrder?.currency &&
    input.canonicalPayment.currency &&
    input.canonicalOrder.currency !== input.canonicalPayment.currency
  ) {
    authorized = false;
    reasonCodes.push("DENY_CURRENCY_MISMATCH");
    gateChecks.push({
      id: "currency_match",
      label: "Order & Payment currency match?",
      answer: `MISMATCH (${input.canonicalOrder.currency} != ${input.canonicalPayment.currency})`,
      passed: false,
    });
  }

  // 3. Original Payment & Order Unpaid Check
  const isOriginalCaptured =
    input.canonicalPayment.captured || input.canonicalPayment.status === "captured";
  const isOrderPaid =
    input.canonicalOrder &&
    (input.canonicalOrder.status === "paid" ||
      input.canonicalOrder.amountPaidMinor >= input.canonicalPayment.amountMinor);

  if (isOriginalCaptured || isOrderPaid) {
    authorized = false;
    reasonCodes.push("DENY_ALREADY_PAID");
    gateChecks.push({
      id: "paid",
      label: "Already paid?",
      answer: "YES (DENIED)",
      passed: false,
    });
  } else {
    reasonCodes.push("PASS_ORIGINAL_UNPAID");
    gateChecks.push({
      id: "paid",
      label: "Already paid?",
      answer: "NO",
      passed: true,
    });
  }

  // 4. Captured Sibling Payments Check
  const hasCapturedSibling = (input.orderPayments || []).some(
    (p) => p.id !== input.canonicalPayment.id && (p.captured || p.status === "captured"),
  );
  if (hasCapturedSibling) {
    authorized = false;
    reasonCodes.push("DENY_CAPTURED_SIBLING");
    gateChecks.push({
      id: "sibling",
      label: "Captured sibling payment?",
      answer: "YES (DENIED)",
      passed: false,
    });
  } else {
    reasonCodes.push("PASS_NO_CAPTURED_SIBLING");
    gateChecks.push({
      id: "sibling",
      label: "Captured sibling payment?",
      answer: "NO",
      passed: true,
    });
  }

  // 5. Active Recovery Link Check (CREATING, CREATED, and UNCERTAIN all block another recovery action)
  if (
    input.existingActiveAction &&
    ["CREATING", "CREATED", "UNCERTAIN"].includes(input.existingActiveAction.status)
  ) {
    authorized = false;
    reasonCodes.push("DENY_ACTIVE_RECOVERY_LINK");
    gateChecks.push({
      id: "active_link",
      label: "Active/Uncertain recovery link exists?",
      answer: `YES (${input.existingActiveAction.status})`,
      passed: false,
    });
  } else {
    gateChecks.push({
      id: "active_link",
      label: "Duplicate recovery?",
      answer: "NO",
      passed: true,
    });
  }

  // 6. Attempt Count Limit Check
  if (input.attemptCount >= input.policy.maxRecoveryAttempts) {
    authorized = false;
    reasonCodes.push("DENY_ATTEMPT_LIMIT_EXCEEDED");
    gateChecks.push({
      id: "attempts",
      label: "Attempts under limit?",
      answer: `NO (${input.attemptCount}/${input.policy.maxRecoveryAttempts})`,
      passed: false,
    });
  } else {
    reasonCodes.push("PASS_ATTEMPT_LIMIT");
    gateChecks.push({
      id: "attempts",
      label: "Attempts under limit?",
      answer: "YES",
      detail: `${input.attemptCount} / ${input.policy.maxRecoveryAttempts}`,
      passed: true,
    });
  }

  // 7. Strategy Check (Clean enum: FRESH_CHECKOUT, MANUAL_REVIEW, STOP_ALREADY_PAID)
  if (input.proposedStrategy === "FRESH_CHECKOUT" && !input.policy.allowFreshCheckout) {
    authorized = false;
    reasonCodes.push("DENY_STRATEGY_NOT_ALLOWED");
    gateChecks.push({
      id: "strategy",
      label: "Recovery strategy allowed?",
      answer: "NO",
      passed: false,
    });
  } else if (
    input.proposedStrategy === "MANUAL_REVIEW" ||
    input.proposedStrategy === "STOP_ALREADY_PAID"
  ) {
    authorized = false;
    reasonCodes.push("DENY_STRATEGY_NOT_ALLOWED");
    gateChecks.push({
      id: "strategy",
      label: "Recovery strategy allowed?",
      answer: input.proposedStrategy,
      passed: false,
    });
  } else {
    reasonCodes.push("PASS_STRATEGY_ALLOWED");
    gateChecks.push({
      id: "strategy",
      label: "Recovery strategy allowed?",
      answer: "YES",
      passed: true,
    });
  }

  // 8. Risk / Unknown Failure Class Check
  if (input.policy.blockRiskOrPolicyFailures && input.failureClass === "RISK_OR_POLICY") {
    authorized = false;
    reasonCodes.push("DENY_RISK_FAILURE");
    gateChecks.push({
      id: "risk",
      label: "Risk / policy failure check",
      answer: "FLAGGED (DENIED)",
      passed: false,
    });
  } else if (input.policy.blockUnknownFailures && input.failureClass === "UNKNOWN") {
    authorized = false;
    reasonCodes.push("DENY_UNKNOWN_FAILURE");
    gateChecks.push({
      id: "risk",
      label: "Known failure class?",
      answer: "UNKNOWN (DENIED)",
      passed: false,
    });
  } else {
    gateChecks.push({
      id: "risk",
      label: "Risk & compliance cleared?",
      answer: "YES",
      passed: true,
    });
  }

  // 9. Confidence Threshold
  if (input.confidence < input.policy.minDiagnosisConfidence) {
    authorized = false;
    reasonCodes.push("DENY_LOW_CONFIDENCE");
    gateChecks.push({
      id: "confidence",
      label: "Diagnosis confidence threshold?",
      answer: `LOW (${Math.round(input.confidence * 100)}%)`,
      passed: false,
    });
  } else {
    reasonCodes.push("PASS_CONFIDENCE_MET");
    gateChecks.push({
      id: "confidence",
      label: "Diagnosis confidence met?",
      answer: "YES",
      detail: `${Math.round(input.confidence * 100)}% >= ${Math.round(input.policy.minDiagnosisConfidence * 100)}%`,
      passed: true,
    });
  }

  // 10. Amount Determinism: derived strictly from canonical Razorpay state
  const exactAmountMinor =
    input.canonicalOrder && input.canonicalOrder.amountDueMinor > 0
      ? input.canonicalOrder.amountDueMinor
      : input.canonicalPayment.amountMinor;

  if (exactAmountMinor > input.policy.maxAutonomousAmountMinor) {
    authorized = false;
    reasonCodes.push("DENY_AMOUNT_LIMIT_EXCEEDED");
    gateChecks.push({
      id: "amount_bound",
      label: "Amount inside policy?",
      answer: "NO",
      passed: false,
    });
  } else {
    reasonCodes.push("PASS_AMOUNT_BOUND");
    gateChecks.push({
      id: "amount_bound",
      label: "Amount inside policy?",
      answer: "YES",
      detail: `₹${(exactAmountMinor / 100).toLocaleString("en-IN")} <= ₹${(input.policy.maxAutonomousAmountMinor / 100).toLocaleString("en-IN")}`,
      passed: true,
    });
  }

  const requiresApproval = exactAmountMinor >= input.policy.requireApprovalAboveMinor;

  return {
    authorized,
    requiresApproval,
    exactAmountMinor,
    currency: input.canonicalPayment.currency || "INR",
    reasonCodes,
    gateChecks,
  };
}

/**
 * Computes a deterministic SHA-256 state hash over safety-critical canonical provider data.
 */
export function computeCanonicalStateHash(params: {
  paymentId: string;
  paymentStatus: string;
  paymentCaptured: boolean;
  paymentAmountMinor: number;
  paymentCurrency: string;
  orderId?: string | null;
  orderStatus?: string;
  orderAmountPaidMinor?: number;
  orderAmountDueMinor?: number;
  siblingPayments?: Array<{ id: string; captured: boolean; amountMinor: number }>;
  policyVersionId?: string;
}): string {
  const normalized = {
    paymentId: params.paymentId,
    paymentStatus: params.paymentStatus,
    paymentCaptured: params.paymentCaptured,
    paymentAmountMinor: params.paymentAmountMinor,
    paymentCurrency: params.paymentCurrency,
    orderId: params.orderId || null,
    orderStatus: params.orderStatus || null,
    orderAmountPaidMinor: params.orderAmountPaidMinor ?? 0,
    orderAmountDueMinor: params.orderAmountDueMinor ?? 0,
    siblingPayments: (params.siblingPayments || [])
      .map((s) => ({ id: s.id, captured: s.captured, amountMinor: s.amountMinor }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    policyVersionId: params.policyVersionId || null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Convenience helper to compute canonical state hash from raw or canonical provider entities.
 */
export function generateCanonicalStateHash(payment: any, order?: any, payments?: any[]): string {
  return computeCanonicalStateHash({
    paymentId: payment?.id || "",
    paymentStatus: payment?.status || "",
    paymentCaptured: Boolean(payment?.captured || payment?.status === "captured"),
    paymentAmountMinor: payment?.amount ?? payment?.amountMinor ?? 0,
    paymentCurrency: payment?.currency || "INR",
    orderId: order?.id || null,
    orderStatus: order?.status || null,
    orderAmountPaidMinor: order?.amount_paid ?? order?.amountPaidMinor ?? 0,
    orderAmountDueMinor: order?.amount_due ?? order?.amountDueMinor ?? 0,
    siblingPayments: (payments || []).map((p: any) => ({
      id: p.id,
      captured: Boolean(p.captured || p.status === "captured"),
      amountMinor: p.amount ?? p.amountMinor ?? 0,
    })),
  });
}
