import { describe, it, expect, vi, beforeEach } from "vitest";
import { processCanonicalFailedPayment } from "./process-failed-payment";
import * as paymentsMod from "@/lib/razorpay/payments";
import * as runnerMod from "@/lib/graph/runner";
import { supabase } from "@/lib/db/supabase";

describe("Canonical Failed Payment Processor & Idempotency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects payments that do not have status === 'failed'", async () => {
    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_captured_123",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "captured",
      order_id: "order_123",
      invoice_id: null,
      international: false,
      method: "card",
      amount_refunded: 0,
      refund_status: null,
      captured: true,
      created_at: Date.now(),
    });

    await expect(
      processCanonicalFailedPayment({
        paymentId: "pay_captured_123",
        orderId: "order_123",
        provenance: "CANONICAL_API_RECONCILIATION",
      })
    ).rejects.toThrow("expected 'failed'");
  });

  it("rejects payments when orderId does not match canonical order", async () => {
    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_failed_123",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_correct_123",
      invoice_id: null,
      international: false,
      method: "card",
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      created_at: Date.now(),
    });

    await expect(
      processCanonicalFailedPayment({
        paymentId: "pay_failed_123",
        orderId: "order_wrong_456",
        provenance: "CANONICAL_API_RECONCILIATION",
      })
    ).rejects.toThrow("order mismatch");
  });

  it("creates a recovery case and starts LangGraph workflow on verified failed payment", async () => {
    const workflowSpy = vi
      .spyOn(runnerMod, "startRecoveryWorkflow")
      .mockResolvedValue(undefined);

    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_failed_test_001",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_test_001",
      invoice_id: null,
      international: false,
      method: "card",
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      error_code: "BAD_REQUEST_ERROR",
      error_description: "Payment failed at bank gateway",
      error_reason: "payment_failed",
      created_at: Date.now(),
    });

    // Mock supabase select (no existing case)
    const selectMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    });
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "recovery_cases") {
        return { select: selectMock, insert: insertMock } as any;
      }
      if (table === "test_payment_sessions") {
        return { update: updateMock } as any;
      }
      if (table === "case_events") {
        return { insert: insertMock } as any;
      }
      return {} as any;
    });

    const result = await processCanonicalFailedPayment({
      paymentId: "pay_failed_test_001",
      orderId: "order_test_001",
      provenance: "CANONICAL_API_RECONCILIATION",
    });

    expect(result.success).toBe(true);
    expect(result.isNew).toBe(true);
    expect(result.paymentId).toBe("pay_failed_test_001");
    expect(workflowSpy).toHaveBeenCalledTimes(1);
  });

  it("is strictly idempotent: returns existing case and avoids starting duplicate workflow when webhook follows reconciliation", async () => {
    const workflowSpy = vi
      .spyOn(runnerMod, "startRecoveryWorkflow")
      .mockResolvedValue(undefined);

    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_failed_dup_001",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_dup_001",
      invoice_id: null,
      international: false,
      method: "card",
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      created_at: Date.now(),
    });

    // Mock supabase to return an existing case
    const selectMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: "case-existing-uuid",
            case_number: "RCV-99999",
            status: "PAYMENT_FAILED",
          },
          error: null,
        }),
      }),
    });
    const updateMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "recovery_cases") {
        return { select: selectMock } as any;
      }
      if (table === "test_payment_sessions") {
        return { update: updateMock } as any;
      }
      return {} as any;
    });

    const result = await processCanonicalFailedPayment({
      paymentId: "pay_failed_dup_001",
      orderId: "order_dup_001",
      provenance: "WEBHOOK",
    });

    expect(result.success).toBe(true);
    expect(result.isNew).toBe(false);
    expect(result.caseId).toBe("case-existing-uuid");
    expect(result.caseNumber).toBe("RCV-99999");
    // Ensure duplicate workflow was NOT started!
    expect(workflowSpy).not.toHaveBeenCalled();
  });
});
