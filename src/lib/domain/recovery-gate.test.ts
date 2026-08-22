import { describe, it, expect } from "vitest";
import { formatINRMinor, isValidMinorAmount } from "./money";
import { evaluateRecoveryGate } from "./recovery-gate";

describe("Domain Money Arithmetic", () => {
  it("formats minor currency units in Indian numbering format", () => {
    expect(formatINRMinor(299900)).toBe("₹2,999");
    expect(formatINRMinor(735000)).toBe("₹7,350");
    expect(formatINRMinor(10050)).toBe("₹100.50");
  });

  it("validates minor amount within allowed ranges", () => {
    expect(isValidMinorAmount(10000)).toBe(true); // ₹100
    expect(isValidMinorAmount(1000000)).toBe(true); // ₹10,000
    expect(isValidMinorAmount(5000)).toBe(false); // Too low
    expect(isValidMinorAmount(2000000)).toBe(false); // Too high
  });
});

describe("Deterministic Recovery Gate", () => {
  const baseInput = {
    isTestMode: true,
    canonicalPayment: {
      id: "pay_test_123",
      amountMinor: 299900,
      currency: "INR",
      status: "failed",
      captured: false,
      errorCode: "BAD_REQUEST_ERROR",
    },
    canonicalOrder: {
      id: "order_test_123",
      amountMinor: 299900,
      amountPaidMinor: 0,
      status: "attempted",
    },
    orderPayments: [],
    attemptCount: 0,
    failureClass: "CUSTOMER_CORRECTABLE",
    confidence: 0.92,
    proposedStrategy: "FRESH_CHECKOUT",
    policy: {
      maxRecoveryAttempts: 2,
      maxAutonomousAmountMinor: 1000000,
      requireApprovalAboveMinor: 0,
      allowFreshCheckout: true,
      minDiagnosisConfidence: 0.7,
      blockRiskOrPolicyFailures: true,
      blockUnknownFailures: true,
    },
  };

  it("authorizes valid unpaid customer correctable failure in test mode", () => {
    const result = evaluateRecoveryGate(baseInput);
    expect(result.authorized).toBe(true);
    expect(result.exactAmountMinor).toBe(299900);
    expect(result.reasonCodes).toContain("PASS_TEST_MODE");
    expect(result.reasonCodes).toContain("PASS_ORIGINAL_UNPAID");
  });

  it("strictly denies authorization if original payment is already captured", () => {
    const result = evaluateRecoveryGate({
      ...baseInput,
      canonicalPayment: {
        ...baseInput.canonicalPayment,
        captured: true,
        status: "captured",
      },
    });
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_ALREADY_PAID");
  });

  it("strictly blocks risk/compliance failure classes", () => {
    const result = evaluateRecoveryGate({
      ...baseInput,
      failureClass: "RISK_OR_POLICY",
    });
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_RISK_FAILURE");
  });

  it("strictly denies when attempt limit is exceeded", () => {
    const result = evaluateRecoveryGate({
      ...baseInput,
      attemptCount: 2,
    });
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_ATTEMPT_LIMIT_EXCEEDED");
  });
});
