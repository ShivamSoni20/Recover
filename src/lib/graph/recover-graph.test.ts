import { describe, it, expect, vi } from "vitest";
import { createRecoverGraph } from "./recover-graph";
import { MemorySaver, Command } from "@langchain/langgraph";

// Mock Razorpay and AI calls for graph topology test
vi.mock("../razorpay/payments", () => ({
  fetchRazorpayPayment: vi.fn().mockImplementation(async (id: string) => {
    if (id === "pay_recovery_123") {
      return {
        id: "pay_recovery_123",
        amount: 299900,
        currency: "INR",
        status: "captured",
        captured: true,
        method: "card",
      };
    }
    return {
      id: "pay_test_stub_1",
      amount: 299900,
      currency: "INR",
      status: "failed",
      captured: false,
      method: "upi",
      error_code: "BAD_REQUEST_ERROR",
      error_description: "Payment failed at bank",
      error_reason: "payment_failed",
    };
  }),
  fetchPaymentsForOrder: vi.fn().mockResolvedValue([]),
}));

vi.mock("../razorpay/orders", () => ({
  fetchRazorpayOrder: vi.fn().mockResolvedValue({
    id: "order_test_stub_1",
    amount: 299900,
    amount_paid: 0,
    amount_due: 299900,
    currency: "INR",
    status: "attempted",
    attempts: 1,
  }),
}));

vi.mock("../razorpay/payment-links", () => ({
  createRecoveryPaymentLink: vi.fn().mockResolvedValue({
    id: "plink_test_stub_1",
    amount: 299900,
    currency: "INR",
    status: "created",
    short_url: "https://rzp.io/i/testlink",
  }),
  fetchPaymentLink: vi.fn().mockResolvedValue({
    id: "plink_test_stub_1",
    reference_id: "rcv_case_tes_1",
    amount: 299900,
    amount_paid: 299900,
    currency: "INR",
    status: "paid",
    short_url: "https://rzp.io/i/testlink",
  }),
  cancelPaymentLink: vi.fn().mockResolvedValue({ id: "plink_test_stub_1", status: "cancelled" }),
  findPaymentLinkByReferenceId: vi.fn().mockResolvedValue(null),
}));

vi.mock("../ai/model", () => ({
  getRecoverModel: vi.fn().mockReturnValue({
    withStructuredOutput: vi.fn().mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        failureClass: "CUSTOMER_CORRECTABLE",
        confidence: 0.92,
        evidenceFields: ["error_code", "error_description"],
        knowledgeRefs: ["knowledge/razorpay-recovery-runbook.md"],
        summary: "Customer payment failed due to bank timeout, safe to retry.",
        strategy: "FRESH_CHECKOUT",
        explanation: "Fresh checkout is recommended.",
        recommendedDelaySeconds: 0,
      }),
    }),
  }),
}));

vi.mock("../ai/rag-retriever", () => ({
  retrieveRecoveryKnowledge: vi.fn().mockResolvedValue([
    {
      chunkId: "chunk-1",
      source: "knowledge/razorpay-recovery-runbook.md",
      content: "Fresh checkout is safe for customer correctable errors.",
      score: 0.95,
    },
  ]),
}));

vi.mock("../domain/recovery-policy", () => ({
  getActiveRecoveryPolicy: vi.fn().mockResolvedValue({
    id: "00000000-0000-0000-0000-000000000001",
    versionTag: "policy-test",
    maxRecoveryAttempts: 2,
    maxAutonomousAmountMinor: 1000000,
    requireApprovalAboveMinor: 0,
    allowFreshCheckout: true,
    linkExpiryMinutes: 60,
    minDiagnosisConfidence: 0.7,
    blockRiskOrPolicyFailures: true,
    blockUnknownFailures: true,
  }),
}));

vi.mock("../db/supabase", () => ({
  supabase: {
    from: () => ({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: "auth-1" }, error: null }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
      upsert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: "action-1" }, error: null }),
        }),
      }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    }),
  },
}));

describe("LangGraph Recover Workflow - Complete Closed Loop", () => {
  it("executes through canonicalization, diagnosis, gate, and pauses at approval interrupt", async () => {
    const memory = new MemorySaver();
    const graph = createRecoverGraph().compile({ checkpointer: memory });

    const threadId = "case_test_thread_123";
    const config = { configurable: { thread_id: threadId } };

    const result = await graph.invoke(
      {
        caseId: threadId,
        threadId,
        originalOrderId: "order_test_stub_1",
        originalPaymentId: "pay_test_stub_1",
      },
      config
    );

    // Should have diagnosed and evaluated gate
    expect(result.gate?.authorized).toBe(true);
    expect(result.gate?.exactAmountMinor).toBe(299900);
    expect(result.diagnosis?.failureClass).toBe("CUSTOMER_CORRECTABLE");
  });

  it("resumes on human approval, creates recovery payment link, and pauses at recovery payment interrupt", async () => {
    const memory = new MemorySaver();
    const graph = createRecoverGraph().compile({ checkpointer: memory });

    const threadId = "case_test_thread_456";
    const config = { configurable: { thread_id: threadId } };

    // Initial invoke -> hits await_approval_interrupt
    await graph.invoke(
      {
        caseId: threadId,
        threadId,
        originalOrderId: "order_test_stub_1",
        originalPaymentId: "pay_test_stub_1",
      },
      config
    );

    // Resume with operator approval
    const resumedResult = await graph.invoke(
      new Command({ resume: { decision: "APPROVE_RECOVERY" } }),
      config
    );

    expect(resumedResult.approval?.status).toBe("APPROVED");
    expect(resumedResult.action?.status).toBe("CREATED");
    expect(resumedResult.action?.paymentLinkId).toBe("plink_test_stub_1");
  });

  it("resumes on recovery payment event and finishes with RECOVERED_VERIFIED receipt", async () => {
    const memory = new MemorySaver();
    const graph = createRecoverGraph().compile({ checkpointer: memory });

    const threadId = "case_test_thread_789";
    const config = { configurable: { thread_id: threadId } };

    // Step 1: Initial invoke
    await graph.invoke(
      {
        caseId: threadId,
        threadId,
        originalOrderId: "order_test_stub_1",
        originalPaymentId: "pay_test_stub_1",
      },
      config
    );

    // Step 2: Resume approval
    await graph.invoke(
      new Command({ resume: { decision: "APPROVE_RECOVERY" } }),
      config
    );

    // Step 3: Resume recovery payment
    const finalResult = await graph.invoke(
      new Command({
        resume: {
          kind: "RECOVERY_PAYMENT_CAPTURED",
          eventType: "payment.captured",
          paymentId: "pay_recovery_123",
          paymentLinkId: "plink_test_stub_1",
        },
      }),
      config
    );

    expect(finalResult.terminalStatus).toBe("RECOVERED_VERIFIED");
    expect(finalResult.verification?.status).toBe("VERIFIED");
    expect(finalResult.verification?.checks.every((c) => c.passed)).toBe(true);
  });
});
