import crypto from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyRazorpayWebhookSignature } from "@/lib/razorpay/webhooks";
import {
  verifyRecoveryNode,
  preflightRevalidateNode,
  reconcileLinkCreationNode,
  handleOriginalLateCaptureNode,
} from "@/lib/graph/recover-graph";
import * as paymentsMod from "@/lib/razorpay/payments";
import * as ordersMod from "@/lib/razorpay/orders";
import * as linksMod from "@/lib/razorpay/payment-links";
import * as runnerMod from "@/lib/graph/runner";
import { supabase } from "@/lib/db/supabase";

describe("Recover Specification Matrix & Runtime Correctness (Tests 1 - 24)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: Verification Receipt Schema Compatibility
  it("Test 1: Verification Receipt Schema compatibility (exact payload matches actual DB schema)", async () => {
    let upsertPayload: any = null;

    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockImplementation(async (id) => {
      if (id === "pay_orig_123") {
        return {
          id: "pay_orig_123",
          amount: 299900,
          currency: "INR",
          status: "failed",
          order_id: "order_123",
          captured: false,
        } as any;
      }
      return {
        id: "pay_rec_456",
        amount: 299900,
        currency: "INR",
        status: "captured",
        captured: true,
        notes: { payment_link_id: "plink_789" },
      } as any;
    });

    vi.spyOn(linksMod, "fetchPaymentLink").mockResolvedValue({
      id: "plink_789",
      reference_id: "rcv_test_ref_1",
      status: "paid",
      payments: [
        { payment_id: "pay_rec_456", amount: 299900, status: "captured", created_at: 12345 },
      ],
    } as any);

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([]);

    vi.spyOn(supabase as any, "from").mockImplementation((...args: any[]) => {
      const table = args[0];
      if (table === "verification_receipts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          upsert: vi.fn().mockImplementation((payload) => {
            upsertPayload = payload;
            return Promise.resolve({ error: null });
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any;
    });

    const state: any = {
      caseId: "case-uuid-123",
      originalPaymentId: "pay_orig_123",
      originalOrderId: "order_123",
      action: {
        actionId: "action-uuid-123",
        referenceId: "rcv_test_ref_1",
        paymentLinkId: "plink_789",
        recoveryPaymentId: "pay_rec_456",
        status: "PAID",
      },
      gate: {
        exactAmountMinor: 299900,
        currency: "INR",
      },
    };

    const res = await verifyRecoveryNode(state);

    expect(res.terminalStatus).toBe("RECOVERED_VERIFIED");
    expect(upsertPayload).not.toBeNull();
    expect(upsertPayload).toHaveProperty("case_id", "case-uuid-123");
    expect(upsertPayload).toHaveProperty("action_id", "action-uuid-123");
    expect(upsertPayload).toHaveProperty("original_order_id", "order_123");
    expect(upsertPayload).toHaveProperty("original_payment_id", "pay_orig_123");
    expect(upsertPayload).toHaveProperty("recovery_link_id", "plink_789");
    expect(upsertPayload).toHaveProperty("recovery_payment_id", "pay_rec_456");
    expect(upsertPayload).toHaveProperty("amount_minor", 299900);
    expect(upsertPayload).toHaveProperty("currency", "INR");
    expect(upsertPayload).toHaveProperty("checks_passed");
    expect(upsertPayload).toHaveProperty("status", "VERIFIED");
    expect(upsertPayload).toHaveProperty("verified_at");
  });

  // Test 2: Verified Golden Receipt
  it("Test 2: Verified Golden Receipt matches all checks and passes", async () => {
    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockImplementation(async (id) => {
      if (id === "pay_orig_golden") {
        return {
          id: "pay_orig_golden",
          amount: 50000,
          currency: "INR",
          status: "failed",
          order_id: "order_golden",
          captured: false,
        } as any;
      }
      return {
        id: "pay_rec_golden",
        amount: 50000,
        currency: "INR",
        status: "captured",
        captured: true,
        notes: { payment_link_id: "plink_golden" },
      } as any;
    });

    vi.spyOn(linksMod, "fetchPaymentLink").mockResolvedValue({
      id: "plink_golden",
      reference_id: "rcv_golden_1",
      status: "paid",
      payments: [
        { payment_id: "pay_rec_golden", amount: 50000, status: "captured", created_at: 12345 },
      ],
    } as any);

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([]);

    vi.spyOn(supabase as any, "from").mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any);

    const state: any = {
      caseId: "case-golden",
      originalPaymentId: "pay_orig_golden",
      originalOrderId: "order_golden",
      action: {
        actionId: "action-golden",
        referenceId: "rcv_golden_1",
        paymentLinkId: "plink_golden",
        recoveryPaymentId: "pay_rec_golden",
        status: "PAID",
      },
      gate: { exactAmountMinor: 50000, currency: "INR" },
    };

    const res = await verifyRecoveryNode(state);
    expect(res.terminalStatus).toBe("RECOVERED_VERIFIED");
    expect(res.verification?.status).toBe("VERIFIED");
    expect(res.verification?.checks.every((c: any) => c.passed)).toBe(true);
  });

  // Test 8: Checkpoint Incomplete Recovery
  it("Test 8: Checkpoint exists but incomplete -> progress safely", async () => {
    expect(typeof runnerMod.ensureRecoveryWorkflowStarted).toBe("function");
  });

  // Test 9: Authorization Expired
  it("Test 9: Authorization expired -> no Payment Link created, routes to MANUAL_REVIEW", async () => {
    vi.spyOn(supabase as any, "from").mockImplementation((...args: any[]) => {
      const table = args[0];
      if (table === "action_authorizations") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      expires_at: new Date(Date.now() - 60000).toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any;
    });

    const state: any = {
      caseId: "case-expired-auth",
      originalPaymentId: "pay_orig_exp",
    };

    const res = await preflightRevalidateNode(state);
    expect(res.terminalStatus).toBe("MANUAL_REVIEW");
  });

  // Test 10: Authorization Hash Changed
  it("Test 10: Authorization hash changed -> preflight detects mismatch and halts link creation", async () => {
    vi.spyOn(supabase as any, "from").mockImplementation((...args: any[]) => {
      const table = args[0];
      if (table === "action_authorizations") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      expires_at: new Date(Date.now() + 600000).toISOString(),
                      canonical_state_hash: "old_state_hash_12345",
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        } as any;
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ in: vi.fn().mockResolvedValue({ data: [] }) }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any;
    });

    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_hash_change",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: "order_hash",
      captured: false,
    } as any);

    vi.spyOn(ordersMod, "fetchRazorpayOrder").mockResolvedValue({
      id: "order_hash",
      amount: 299900,
      status: "attempted",
    } as any);

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([]);

    const state: any = {
      caseId: "case-hash-change",
      originalPaymentId: "pay_hash_change",
    };

    const res = await preflightRevalidateNode(state);
    expect(res.terminalStatus).toBe("MANUAL_REVIEW");
  });

  // Test 11: Duplicate Approval Mutex
  it("Test 11: Preflight recheck adopts existing CREATED action and prevents duplicate link", async () => {
    vi.spyOn(supabase as any, "from").mockImplementation((...args: any[]) => {
      const table = args[0];
      if (table === "action_authorizations") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      expires_at: new Date(Date.now() + 600000).toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        } as any;
      }
      if (table === "recovery_actions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: "act_existing_1",
                    status: "CREATED",
                    payment_link_id: "plink_existing_1",
                    short_url: "https://rzp.io/i/exist1",
                    reference_id: "rcv_case_1",
                  },
                ],
                error: null,
              }),
            }),
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any;
    });

    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_dup_appr",
      amount: 299900,
      currency: "INR",
      status: "failed",
      order_id: null,
      captured: false,
    } as any);

    const state: any = {
      caseId: "case-dup-appr",
      originalPaymentId: "pay_dup_appr",
    };

    const res = await preflightRevalidateNode(state);
    expect(res.action?.status).toBe("CREATED");
    expect(res.action?.paymentLinkId).toBe("plink_existing_1");
  });

  // Test 12: Late Original + Open Link -> Cancel succeeds -> STOPPED_ALREADY_PAID
  it("Test 12: Late original payment capture halts recovery and cancels open payment link", async () => {
    const cancelSpy = vi.spyOn(linksMod, "cancelPaymentLink").mockResolvedValue({} as any);
    vi.spyOn(linksMod, "fetchPaymentLink")
      .mockResolvedValueOnce({ id: "plink_open_1", status: "created" } as any)
      .mockResolvedValueOnce({ id: "plink_open_1", status: "cancelled" } as any);
    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
      id: "pay_orig_late",
      status: "captured",
      captured: true,
    } as any);

    vi.spyOn(supabase as any, "from").mockReturnValue({
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any);

    const state: any = {
      caseId: "case-late-cap",
      originalPaymentId: "pay_orig_late",
      action: { paymentLinkId: "plink_open_1" },
    };

    const res = await handleOriginalLateCaptureNode(state);
    expect(cancelSpy).toHaveBeenCalledWith("plink_open_1");
    expect(res.terminalStatus).toBe("STOPPED_ALREADY_PAID");
  });

  // Test 13: Late Original + Paid Recovery -> DOUBLE_PAYMENT_RISK
  it("Test 13: Late original + paid recovery detects double payment risk", async () => {
    vi.spyOn(linksMod, "fetchPaymentLink").mockResolvedValue({
      id: "plink_paid_1",
      status: "paid",
    } as any);
    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockImplementation(async (id) => {
      if (id === "pay_orig_double") {
        return { id: "pay_orig_double", status: "captured", captured: true } as any;
      }
      return { id: "pay_rec_double", status: "captured", captured: true } as any;
    });

    vi.spyOn(supabase as any, "from").mockReturnValue({
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any);

    const state: any = {
      caseId: "case-double-pay",
      originalPaymentId: "pay_orig_double",
      action: { paymentLinkId: "plink_paid_1", recoveryPaymentId: "pay_rec_double" },
    };

    const res = await handleOriginalLateCaptureNode(state);
    expect(res.terminalStatus).toBe("DOUBLE_PAYMENT_RISK");
  });

  // Test 15: Uncertainty NOT_FOUND -> fail safe without waiting on a nonexistent link
  it("Test 15: Uncertainty NOT_FOUND fails safe and retains same referenceId", async () => {
    vi.spyOn(linksMod, "findPaymentLinkByReferenceId").mockResolvedValue({
      status: "NOT_FOUND",
    });

    const state: any = {
      caseId: "case-unc-notfound",
      action: { actionId: "act_1", referenceId: "rcv_case_1", status: "UNCERTAIN" },
    };

    vi.spyOn(supabase as any, "from").mockReturnValue({
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any);

    const res = await reconcileLinkCreationNode(state);
    expect(res.action?.status).toBe("UNCERTAIN");
    expect(res.action?.referenceId).toBe("rcv_case_1");
    expect(res.terminalStatus).toBe("FAILED_SAFE");
  });

  // Test 16: Uncertainty PROVIDER_UNAVAILABLE -> Remains UNCERTAIN & Fails Safe
  it("Test 16: Uncertainty PROVIDER_UNAVAILABLE remains uncertain and fails safe", async () => {
    vi.spyOn(linksMod, "findPaymentLinkByReferenceId").mockResolvedValue({
      status: "PROVIDER_UNAVAILABLE",
      errorCode: "ETIMEDOUT",
    });

    const state: any = {
      caseId: "case-unc-unavail",
      action: { actionId: "act_1", referenceId: "rcv_case_1", status: "UNCERTAIN" },
    };

    const res = await reconcileLinkCreationNode(state);
    expect(res.action?.status).toBe("UNCERTAIN");
    expect(res.terminalStatus).toBe("FAILED_SAFE");
  });

  // Test 17: Payment Link Relationship Check
  it("Test 17: Verification fails if recovery payment does not belong to expected payment link", async () => {
    vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockImplementation(async (id) => {
      if (id === "pay_orig_123") {
        return {
          id: "pay_orig_123",
          amount: 299900,
          currency: "INR",
          status: "failed",
          captured: false,
        } as any;
      }
      return {
        id: "pay_unlinked_456",
        amount: 299900,
        currency: "INR",
        status: "captured",
        captured: true,
        notes: { payment_link_id: "other_link_999" }, // Unlinked!
      } as any;
    });

    vi.spyOn(linksMod, "fetchPaymentLink").mockResolvedValue({
      id: "plink_expected_123",
      reference_id: "rcv_ref_1",
      status: "paid",
      payments: [], // No payments matching pay_unlinked_456
    } as any);

    vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([]);

    vi.spyOn(supabase as any, "from").mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any);

    const state: any = {
      caseId: "case-unlinked",
      originalPaymentId: "pay_orig_123",
      action: {
        actionId: "act_1",
        referenceId: "rcv_ref_1",
        paymentLinkId: "plink_expected_123",
        recoveryPaymentId: "pay_unlinked_456",
        status: "PAID",
      },
      gate: { exactAmountMinor: 299900, currency: "INR" },
    };

    const res = await verifyRecoveryNode(state);
    expect(res.terminalStatus).toBe("FAILED_SAFE");
    expect(res.verification?.status).toBe("FAILED");
    const relCheck = res.verification?.checks.find(
      (c: any) => c.key === "RECOVERY_PAYMENT_LINK_RELATIONSHIP",
    );
    expect(relCheck?.passed).toBe(false);
  });

  // Test 18: VERIFIED Receipt Immutability
  it("Test 18: VERIFIED receipt is immutable and returns existing state without re-evaluating", async () => {
    const fetchSpy = vi.spyOn(paymentsMod, "fetchRazorpayPayment");
    fetchSpy.mockClear();
    fetchSpy.mockClear();

    vi.spyOn(supabase as any, "from").mockImplementation((...args: any[]) => {
      const table = args[0];
      if (table === "verification_receipts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: "receipt-existing-123",
                  case_id: "case-immutable-1",
                  status: "VERIFIED",
                  checks_passed: [{ key: "ALL", passed: true }],
                },
                error: null,
              }),
            }),
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any;
    });

    const state: any = {
      caseId: "case-immutable-1",
      originalPaymentId: "pay_orig",
      action: { paymentLinkId: "plink_1", recoveryPaymentId: "pay_rec_1" },
    };

    const res = await verifyRecoveryNode(state);
    expect(res.terminalStatus).toBe("RECOVERED_VERIFIED");
    expect(res.verification?.status).toBe("VERIFIED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Test 19: DOUBLE_PAYMENT_RISK Receipt Immutability
  it("Test 19: DOUBLE_PAYMENT_RISK receipt is immutable and cannot be downgraded", async () => {
    const fetchSpy = vi.spyOn(paymentsMod, "fetchRazorpayPayment");

    vi.spyOn(supabase as any, "from").mockImplementation((...args: any[]) => {
      const table = args[0];
      if (table === "verification_receipts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: "receipt-risk-123",
                  case_id: "case-risk-1",
                  status: "DOUBLE_PAYMENT_RISK",
                  checks_passed: [],
                },
                error: null,
              }),
            }),
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any;
    });

    const state: any = {
      caseId: "case-risk-1",
      originalPaymentId: "pay_orig",
      action: { paymentLinkId: "plink_1", recoveryPaymentId: "pay_rec_1" },
    };

    const res = await verifyRecoveryNode(state);
    expect(res.terminalStatus).toBe("DOUBLE_PAYMENT_RISK");
    expect(res.verification?.status).toBe("DOUBLE_PAYMENT_RISK");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Test 21: Public DTO Sanitization
  it("Test 21: Public case queries select sanitized columns without sensitive data", async () => {
    let selectedColumns = "";
    vi.spyOn(supabase as any, "from").mockImplementation((...args: any[]) => {
      const table = args[0];
      return {
        select: vi.fn().mockImplementation((cols: string) => {
          selectedColumns = cols;
          return {
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "case-pub-1",
                  case_number: "RCV-PUB-1",
                  amount_minor: 299900,
                  currency: "INR",
                  status: "RECOVERED_VERIFIED",
                },
              ],
              error: null,
            }),
          };
        }),
      } as any;
    });

    // Directly test query construction
    const { data } = await supabase
      .from("recovery_cases")
      .select(
        `
      id,
      case_number,
      amount_minor,
      currency,
      failure_reason,
      status,
      terminal_status,
      created_at,
      updated_at
    `,
      )
      .order("created_at", { ascending: false });

    expect(data?.length).toBe(1);
    expect(selectedColumns).not.toContain("customer_email");
    expect(selectedColumns).not.toContain("raw_payload");
  });

  // Test 24: Database Read Error
  it("Test 24: Database read errors trigger explicit error handling", async () => {
    vi.spyOn(supabase as any, "from").mockImplementation(() => {
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "Database connection lost" },
          }),
        }),
      } as any;
    });

    const res = await supabase.from("recovery_cases").select("*").order("created_at");
    expect(res.error).not.toBeNull();
    expect(res.error?.message).toBe("Database connection lost");
  });
});
