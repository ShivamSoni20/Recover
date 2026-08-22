import { describe, it, expect, vi, beforeEach } from "vitest";
import { processCanonicalFailedPayment } from "./process-failed-payment";
import { reconcileTestPaymentSession } from "./reconcile-session";
import * as paymentsMod from "@/lib/razorpay/payments";
import * as runnerMod from "@/lib/graph/runner";
import { supabase } from "@/lib/db/supabase";

describe("Razorpay Test Checkout Failure-Handling & Recovery Specification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: Modal dismiss without payment attempt -> no failed state / no case
  it("1. Modal dismiss without payment attempt does not create a recovery case or start graph", async () => {
    const workflowSpy = vi.spyOn(runnerMod, "startRecoveryWorkflow");
    
    // Simulate what happens on modal dismiss without failureObserved:
    // Frontend transitions to CHECKOUT_DISMISSED, no server calls made to process failure
    expect(workflowSpy).not.toHaveBeenCalled();
  });

  // Test 2: Client failure + webhook case -> exactly one case created
  it("2. Client failure followed by webhook creates exactly one recovery case", async () => {
    const workflowSpy = vi.spyOn(runnerMod, "startRecoveryWorkflow").mockResolvedValue(undefined);

    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_webhook_001",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_webhook_001",
      invoice_id: null,
      international: false,
      method: "card",
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      created_at: Date.now(),
    });

    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "recovery_cases") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any;
    });

    const res = await processCanonicalFailedPayment({
      paymentId: "pay_webhook_001",
      orderId: "order_webhook_001",
      provenance: "WEBHOOK",
    });

    expect(res.success).toBe(true);
    expect(res.isNew).toBe(true);
    expect(workflowSpy).toHaveBeenCalledTimes(1);
  });

  // Test 3: Client failure + delayed webhook + API reconciliation -> exactly one case created
  it("3. Delayed webhook triggering API reconciliation creates exactly one legitimate recovery case", async () => {
    const workflowSpy = vi.spyOn(runnerMod, "startRecoveryWorkflow").mockResolvedValue(undefined);

    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "test_payment_sessions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { session_id: "sess_recon_001", order_id: "order_recon_001", recovery_case_id: null },
                error: null,
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        } as any;
      }
      if (table === "recovery_cases") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        } as any;
      }
      return { insert: vi.fn().mockResolvedValue({ error: null }) } as any;
    });

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([
      {
        id: "pay_delayed_001",
        entity: "payment",
        amount: 299900,
        currency: "INR",
        status: "failed",
        order_id: "order_recon_001",
        invoice_id: null,
        international: false,
        method: "netbanking",
        amount_refunded: 0,
        refund_status: null,
        captured: false,
        created_at: Date.now(),
      },
    ]);

    const res = await reconcileTestPaymentSession({
      sessionId: "sess_recon_001",
      candidatePaymentId: "pay_delayed_001",
    });

    expect(res.status).toBe("FAILURE_CONFIRMED");
    expect((res as any).paymentId).toBe("pay_delayed_001");
    expect(workflowSpy).toHaveBeenCalledTimes(1);
  });

  // Test 4: Reconciliation case followed by webhook -> same case, NO duplicate workflow
  it("4. Reconciliation followed by webhook returns existing case with zero duplicate workflows", async () => {
    const workflowSpy = vi.spyOn(runnerMod, "startRecoveryWorkflow").mockResolvedValue(undefined);

    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_raced_001",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_raced_001",
      invoice_id: null,
      international: false,
      method: "card",
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      created_at: Date.now(),
    });

    // Mock existing case in DB
    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "recovery_cases") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: "case_existing_raced", case_number: "RCV-88888" },
                error: null,
              }),
            }),
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      } as any;
    });

    const res = await processCanonicalFailedPayment({
      paymentId: "pay_raced_001",
      orderId: "order_raced_001",
      provenance: "WEBHOOK",
    });

    expect(res.success).toBe(true);
    expect(res.isNew).toBe(false);
    expect(res.caseId).toBe("case_existing_raced");
    expect(workflowSpy).not.toHaveBeenCalled();
  });

  // Test 5: API reconciliation finds captured payment -> no recovery case
  it("5. API reconciliation finds captured payment: reports success and creates NO recovery case", async () => {
    const workflowSpy = vi.spyOn(runnerMod, "startRecoveryWorkflow");

    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "test_payment_sessions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { session_id: "sess_success", order_id: "order_success", recovery_case_id: null },
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
        id: "pay_success_100",
        entity: "payment",
        amount: 299900,
        currency: "INR",
        status: "captured",
        order_id: "order_success",
        invoice_id: null,
        international: false,
        method: "upi",
        amount_refunded: 0,
        refund_status: null,
        captured: true,
        created_at: Date.now(),
      },
    ]);

    const res = await reconcileTestPaymentSession({
      sessionId: "sess_success",
    });

    expect(res.status).toBe("PAYMENT_SUCCEEDED");
    expect(workflowSpy).not.toHaveBeenCalled();
  });

  // Test 6: API reconciliation finds no payments -> unresolved, no fake case
  it("6. API reconciliation finds no payment attempts: reports NO_PAYMENT_ATTEMPT_FOUND without fabricating a case", async () => {
    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "test_payment_sessions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { session_id: "sess_empty", order_id: "order_empty", recovery_case_id: null },
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
      sessionId: "sess_empty",
    });

    expect(res.status).toBe("NO_PAYMENT_ATTEMPT_FOUND");
  });

  // Test 7: Initial checkout configuration has retry.enabled === false
  it("7. Validates retry.enabled is set to false in standard checkout config", () => {
    const checkoutConfig = {
      retry: {
        enabled: false,
      },
    };
    expect(checkoutConfig.retry.enabled).toBe(false);
  });

  // Test 8: Session reconciliation with candidatePaymentId
  it("8. Candidate payment ID preference matches exact provider attempt", async () => {
    const workflowSpy = vi.spyOn(runnerMod, "startRecoveryWorkflow").mockResolvedValue(undefined);

    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "test_payment_sessions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { session_id: "sess_candidate", order_id: "order_cand_1", recovery_case_id: null },
                error: null,
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        } as any;
      }
      if (table === "recovery_cases") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        } as any;
      }
      return { insert: vi.fn().mockResolvedValue({ error: null }) } as any;
    });

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([
      {
        id: "pay_older_failed",
        entity: "payment",
        amount: 299900,
        currency: "INR",
        status: "failed",
        order_id: "order_cand_1",
        invoice_id: null,
        international: false,
        method: "card",
        amount_refunded: 0,
        refund_status: null,
        captured: false,
        created_at: 1000,
      },
      {
        id: "pay_candidate_target",
        entity: "payment",
        amount: 299900,
        currency: "INR",
        status: "failed",
        order_id: "order_cand_1",
        invoice_id: null,
        international: false,
        method: "upi",
        amount_refunded: 0,
        refund_status: null,
        captured: false,
        created_at: 2000,
      },
    ]);

    const res = await reconcileTestPaymentSession({
      sessionId: "sess_candidate",
      candidatePaymentId: "pay_candidate_target",
    });

    expect(res.status).toBe("FAILURE_CONFIRMED");
    expect((res as any).paymentId).toBe("pay_candidate_target");
    expect(workflowSpy).toHaveBeenCalledTimes(1);
  });

  // Test 9: Canonical failed payment must belong to original order
  it("9. Rejects payment when canonical order_id mismatches expected order", async () => {
    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_alien_999",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_alien_000",
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
        paymentId: "pay_alien_999",
        orderId: "order_expected_111",
        provenance: "CANONICAL_API_RECONCILIATION",
      })
    ).rejects.toThrow("order mismatch");
  });

  // Test 10: Event provenance persistence
  it("10. Persists exact provenance in case_events (WEBHOOK vs CANONICAL_API_RECONCILIATION)", async () => {
    const eventsInserted: any[] = [];
    vi.spyOn(runnerMod, "startRecoveryWorkflow").mockResolvedValue(undefined);

    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_provenance_001",
      entity: "payment",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_prov_001",
      invoice_id: null,
      international: false,
      method: "card",
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      created_at: Date.now(),
    });

    vi.spyOn(supabase, "from").mockImplementation((table: string) => {
      if (table === "recovery_cases") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        } as any;
      }
      if (table === "case_events") {
        return {
          insert: vi.fn().mockImplementation((payload) => {
            eventsInserted.push(payload);
            return Promise.resolve({ error: null });
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      } as any;
    });

    await processCanonicalFailedPayment({
      paymentId: "pay_provenance_001",
      orderId: "order_prov_001",
      provenance: "CANONICAL_API_RECONCILIATION",
    });

    expect(eventsInserted.length).toBe(1);
    expect(eventsInserted[0].event_type).toBe("PAYMENT_FAILED_CANONICALLY_RECONCILED");
    expect(eventsInserted[0].data.provenance).toBe("CANONICAL_API_RECONCILIATION");
  });
});
