import { describe, it, expect, vi } from "vitest";
import { createRecoverGraph } from "./recover-graph";
import { MemorySaver } from "@langchain/langgraph";

// Mock Razorpay and AI calls for graph topology test
vi.mock("../razorpay/payments", () => ({
  fetchRazorpayPayment: vi.fn().mockResolvedValue({
    id: "pay_test_stub_1",
    amount: 299900,
    currency: "INR",
    status: "failed",
    captured: false,
    method: "upi",
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed at bank",
    error_reason: "payment_failed",
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
    short_url: "https://rzp.io/i/stub1",
  }),
  cancelPaymentLink: vi.fn().mockResolvedValue({ id: "plink_test_stub_1", status: "cancelled" }),
}));

vi.mock("../ai/model", () => ({
  getRecoverModel: vi.fn().mockReturnValue({
    withStructuredOutput: vi.fn().mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        failureClass: "CUSTOMER_CORRECTABLE",
        confidence: 0.92,
        evidenceFields: ["error_code", "error_description"],
        knowledgeRefs: ["runbook-section-1"],
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

vi.mock("../db/supabase", () => ({
  supabase: {
    from: () => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: () => ({
        eq: () => ({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    }),
  },
}));

describe("LangGraph Recover Workflow", () => {
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
});
