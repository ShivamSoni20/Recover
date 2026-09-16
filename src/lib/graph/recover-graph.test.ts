import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { createRecoverGraph } from "./recover-graph";

// Mock Razorpay modules
vi.mock("../razorpay/payments", () => ({
  fetchRazorpayPayment: vi.fn().mockImplementation(async (id: string) => {
    if (id === "pay_recovery_123") {
      return {
        id: "pay_recovery_123",
        entity: "payment",
        amount: 299900,
        currency: "INR",
        status: "captured",
        order_id: null,
        invoice_id: null,
        international: false,
        method: "card",
        amount_refunded: 0,
        refund_status: null,
        captured: true,
        description: "Recovery Payment",
        card_id: "card_123",
        bank: null,
        wallet: null,
        vpa: null,
        email: "customer@example.com",
        contact: "+919999999999",
        notes: { payment_link_id: "plink_test_stub_1" },
        fee: 5900,
        tax: 900,
        error_code: null,
        error_description: null,
        error_source: null,
        error_step: null,
        error_reason: null,
        acquirer_data: {},
        created_at: Date.now(),
      };
    }
    return {
      id: "pay_test_stub_1",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_test_stub_1",
      invoice_id: null,
      international: false,
      method: "card",
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      description: "Original Payment",
      card_id: "card_123",
      bank: null,
      wallet: null,
      vpa: null,
      email: "customer@example.com",
      contact: "+919999999999",
      notes: {},
      fee: null,
      tax: null,
      error_code: "BAD_REQUEST_ERROR",
      error_description: "Payment failed due to customer authentication failure.",
      error_source: "customer",
      error_step: "payment_authorization",
      error_reason: "payment_failed",
      acquirer_data: {},
      created_at: Date.now(),
    };
  }),
  fetchPaymentsForOrder: vi.fn().mockResolvedValue([]),
}));

vi.mock("../razorpay/orders", () => ({
  fetchRazorpayOrder: vi.fn().mockResolvedValue({
    id: "order_test_stub_1",
    entity: "order",
    amount: 299900,
    amount_paid: 0,
    amount_due: 299900,
    currency: "INR",
    receipt: "rcv_order_test_1",
    offer_id: null,
    status: "attempted",
    attempts: 1,
    notes: {},
    created_at: Date.now(),
  }),
}));

vi.mock("../razorpay/payment-links", () => ({
  createRecoveryPaymentLink: vi.fn().mockResolvedValue({
    id: "plink_test_stub_1",
    entity: "payment_link",
    amount: 299900,
    amount_paid: 0,
    currency: "INR",
    status: "created",
    reference_id: "rcv_case_test_thread_456_1",
    description: "Recovery Checkout for order_test_stub_1",
    short_url: "https://rzp.io/i/testlink123",
    customer: {
      name: "Customer",
      email: "customer@example.com",
    },
    created_at: Date.now(),
  }),
  fetchPaymentLink: vi.fn().mockImplementation(async (id: string) => ({
    id,
    entity: "payment_link",
    amount: 299900,
    amount_paid: 299900,
    currency: "INR",
    status: "paid",
    reference_id: "rcv_case_tes_1",
    description: "Recovery Checkout",
    short_url: "https://rzp.io/i/testlink123",
    payments: [
      { payment_id: "pay_recovery_123", amount: 299900, status: "captured", created_at: 12345 },
    ],
    created_at: Date.now(),
  })),
  cancelPaymentLink: vi.fn().mockResolvedValue({ id: "plink_test_stub_1", status: "cancelled" }),
  findPaymentLinkByReferenceId: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
}));

vi.mock("../ai/model", () => ({
  getRecoverModel: vi.fn().mockReturnValue({
    withStructuredOutput: vi.fn().mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        failureClass: "AUTHENTICATION_FAILED",
        confidence: 0.92,
        suggestedStrategy: "FRESH_CHECKOUT",
        rootCause: "Customer authentication failure.",
        explanation: "Customer payment failed due to bank timeout, safe to retry.",
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

// Recursive builder mock for Supabase
function createChainMock(finalResult: any = { data: null, error: null }) {
  const chain: any = {
    insert: vi.fn().mockImplementation(() => {
      const p = Promise.resolve(finalResult);
      (p as any).select = vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: "mock-id-1" }, error: null }),
      });
      return p;
    }),
    update: vi.fn().mockImplementation(() => chain),
    upsert: vi.fn().mockImplementation(() => Promise.resolve(finalResult)),
    select: vi.fn().mockImplementation(() => chain),
    eq: vi.fn().mockImplementation(() => chain),
    in: vi.fn().mockImplementation(() => chain),
    order: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    maybeSingle: vi.fn().mockImplementation(() => Promise.resolve(finalResult)),
    single: vi.fn().mockImplementation(() => Promise.resolve(finalResult)),
  };
  return chain;
}

vi.mock("../db/supabase", () => ({
  supabase: {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "recovery_policy_versions") {
        return createChainMock({
          data: {
            id: "policy-test-id",
            version_tag: "policy-test",
            is_active: true,
            max_recovery_attempts: 2,
            max_autonomous_amount_minor: 1000000,
            require_approval_above_minor: 0,
            allow_fresh_checkout: true,
            link_expiry_minutes: 60,
            min_diagnosis_confidence: 0.7,
            block_risk_or_policy_failures: true,
            block_unknown_failures: true,
          },
          error: null,
        });
      }
      if (table === "recovery_actions") return createChainMock({ data: [], error: null });
      return createChainMock();
    }),
  },
}));

describe("LangGraph Recover Workflow - Complete Closed Loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RECOVER_RAZORPAY_MODE = "test";
    process.env.RAZORPAY_KEY_ID = "rzp_test_fixture";
  });

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
      config,
    );

    // Should have diagnosed and evaluated gate
    expect(result.gate?.authorized).toBe(true);
    expect(result.gate?.exactAmountMinor).toBe(299900);
    expect(result.diagnosis?.failureClass).toBe("AUTHENTICATION_FAILED");
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
      config,
    );

    // Resume with operator approval
    const resumedResult = await graph.invoke(
      new Command({ resume: { decision: "APPROVE_RECOVERY" } }),
      config,
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
      config,
    );

    // Step 2: Resume approval
    await graph.invoke(new Command({ resume: { decision: "APPROVE_RECOVERY" } }), config);

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
      config,
    );

    expect(finalResult.terminalStatus).toBe("RECOVERED_VERIFIED");
    expect(finalResult.verification?.status).toBe("VERIFIED");
  });
});
