import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileTestPaymentSession } from "@/lib/recovery/reconcile-session";
import * as paymentsMod from "@/lib/razorpay/payments";
import * as processMod from "@/lib/recovery/process-failed-payment";
import { supabase } from "@/lib/db/supabase";

describe("reconcileTestPaymentSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns SESSION_NOT_FOUND when session does not exist", async () => {
    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "test_payment_sessions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        } as any;
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      } as any;
    });

    const res = await reconcileTestPaymentSession({
      sessionId: "non_existent_sess",
    });

    expect(res.status).toBe("SESSION_NOT_FOUND");
  });

  it("returns NO_PAYMENT_ATTEMPT_FOUND when order has no payments", async () => {
    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "test_payment_sessions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { session_id: "sess_1", order_id: "order_empty_1", recovery_case_id: null },
                error: null,
              }),
            }),
          }),
        } as any;
      }
      if (table === "recovery_cases") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        } as any;
      }
      return {} as any;
    });

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([]);

    const res = await reconcileTestPaymentSession({
      sessionId: "sess_1",
    });

    expect(res.status).toBe("NO_PAYMENT_ATTEMPT_FOUND");
  });

  it("returns PAYMENT_SUCCEEDED when order payment is captured", async () => {
    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "test_payment_sessions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  session_id: "sess_2",
                  order_id: "order_captured_1",
                  recovery_case_id: null,
                },
                error: null,
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        } as any;
      }
      if (table === "recovery_cases") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        } as any;
      }
      return {} as any;
    });

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([
      {
        id: "pay_cap_999",
        entity: "payment",
        amount: 299900,
        currency: "INR",
        status: "captured",
        order_id: "order_captured_1",
        invoice_id: null,
        international: false,
        method: "card",
        amount_refunded: 0,
        refund_status: null,
        captured: true,
        created_at: Date.now(),
      },
    ]);

    const res = await reconcileTestPaymentSession({
      sessionId: "sess_2",
    });

    expect(res.status).toBe("PAYMENT_SUCCEEDED");
    expect((res as any).paymentId).toBe("pay_cap_999");
  });

  it("processes canonical failed payment and returns FAILURE_CONFIRMED", async () => {
    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "test_payment_sessions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { session_id: "sess_3", order_id: "order_failed_1", recovery_case_id: null },
                error: null,
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        } as any;
      }
      if (table === "recovery_cases") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        } as any;
      }
      return {} as any;
    });

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([
      {
        id: "pay_fail_777",
        entity: "payment",
        amount: 299900,
        currency: "INR",
        status: "failed",
        order_id: "order_failed_1",
        invoice_id: null,
        international: false,
        method: "upi",
        amount_refunded: 0,
        refund_status: null,
        captured: false,
        created_at: Date.now(),
      },
    ]);

    const processSpy = vi.spyOn(processMod, "processCanonicalFailedPayment").mockResolvedValue({
      success: true,
      caseId: "case-1234-uuid",
      caseNumber: "RCV-12345",
      isNew: true,
      paymentId: "pay_fail_777",
    });

    const res = await reconcileTestPaymentSession({
      sessionId: "sess_3",
    });

    expect(res.status).toBe("FAILURE_CONFIRMED");
    expect((res as any).caseId).toBe("case-1234-uuid");
    expect((res as any).caseNumber).toBe("RCV-12345");
    expect(processSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_failed_1",
        paymentId: "pay_fail_777",
        provenance: "CANONICAL_API_RECONCILIATION",
      }),
    );
  });
});
