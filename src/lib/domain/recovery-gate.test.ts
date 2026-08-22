import { describe, it, expect } from "vitest";
import { evaluateRecoveryGate } from "./recovery-gate";
import type { RecoveryGateInput } from "./recovery-gate";

describe("Recovery Gate & Edge Scenarios", () => {
  const baseInput: RecoveryGateInput = {
    isTestMode: true,
    canonicalPayment: {
      id: "pay_test_001",
      amountMinor: 735000,
      currency: "INR",
      status: "failed",
      captured: false,
    },
    canonicalOrder: {
      id: "order_test_001",
      amountMinor: 735000,
      amountPaidMinor: 0,
      status: "attempted",
    },
    orderPayments: [],
    attemptCount: 0,
    failureClass: "CUSTOMER_CORRECTABLE",
    confidence: 0.95,
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

  it("authorizes valid customer-correctable failure for FRESH_CHECKOUT", () => {
    const result = evaluateRecoveryGate(baseInput);
    expect(result.authorized).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.exactAmountMinor).toBe(735000);
  });

  it("denies recovery if original payment is captured", () => {
    const input: RecoveryGateInput = {
      ...baseInput,
      canonicalPayment: { ...baseInput.canonicalPayment, captured: true, status: "captured" },
    };
    const result = evaluateRecoveryGate(input);
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_ALREADY_PAID");
  });

  it("denies recovery if a sibling order payment is captured", () => {
    const input: RecoveryGateInput = {
      ...baseInput,
      orderPayments: [
        { id: "pay_test_002", status: "captured", captured: true, amountMinor: 735000 },
      ],
    };
    const result = evaluateRecoveryGate(input);
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_CAPTURED_SIBLING");
  });

  it("denies recovery if attempt count exceeds policy maximum", () => {
    const input: RecoveryGateInput = {
      ...baseInput,
      attemptCount: 2,
    };
    const result = evaluateRecoveryGate(input);
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_ATTEMPT_LIMIT_EXCEEDED");
  });

  it("denies recovery if amount exceeds policy threshold", () => {
    const input: RecoveryGateInput = {
      ...baseInput,
      canonicalPayment: { ...baseInput.canonicalPayment, amountMinor: 5000000 },
    };
    const result = evaluateRecoveryGate(input);
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_AMOUNT_LIMIT_EXCEEDED");
  });

  it("denies recovery if active recovery action already exists", () => {
    const input: RecoveryGateInput = {
      ...baseInput,
      existingActiveAction: { id: "act_001", status: "CREATED" },
    };
    const result = evaluateRecoveryGate(input);
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_ACTIVE_RECOVERY_LINK");
  });

  it("denies recovery if diagnosis confidence is below policy minimum", () => {
    const input: RecoveryGateInput = {
      ...baseInput,
      confidence: 0.5,
    };
    const result = evaluateRecoveryGate(input);
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_LOW_CONFIDENCE");
  });

  it("denies recovery if failure is marked as RISK_OR_POLICY", () => {
    const input: RecoveryGateInput = {
      ...baseInput,
      failureClass: "RISK_OR_POLICY",
    };
    const result = evaluateRecoveryGate(input);
    expect(result.authorized).toBe(false);
    expect(result.reasonCodes).toContain("DENY_RISK_FAILURE");
  });
});
