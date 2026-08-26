import crypto from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyRazorpayWebhookSignature } from "@/lib/razorpay/webhooks";
import { evaluateRecoveryGate, computeCanonicalStateHash } from "@/lib/domain/recovery-gate";
import {
  verifyRecoveryNode,
  preflightRevalidateNode,
  reconcileLinkCreationNode,
  handleOriginalLateCaptureNode,
} from "@/lib/graph/recover-graph";
import * as paymentsMod from "@/lib/razorpay/payments";
import * as ordersMod from "@/lib/razorpay/orders";
import * as linksMod from "@/lib/razorpay/payment-links";
import { supabase } from "@/lib/db/supabase";

describe("Specification Matrix A through R", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Scenario B: Signature verification
  describe("Scenario B: HMAC Signature Verification", () => {
    it("rejects modified body, wrong secret, or missing signature", () => {
      const secret = "test_secret_12345";
      process.env.RAZORPAY_WEBHOOK_SECRET = secret;

      const body = JSON.stringify({ event: "payment.failed" });
      const validSignature = crypto.createHmac("sha256", secret).update(body).digest("hex");

      expect(verifyRazorpayWebhookSignature(body, validSignature)).toBe(true);
      expect(verifyRazorpayWebhookSignature(body + "tampered", validSignature)).toBe(false);
      expect(verifyRazorpayWebhookSignature(body, "wrong_sig_value")).toBe(false);
      expect(verifyRazorpayWebhookSignature(body, null)).toBe(false);
    });
  });

  // Scenario I: Preflight revalidation
  describe("Scenario I: Preflight Revalidation", () => {
    it("halts with STOPPED_ALREADY_PAID if original payment captures before link creation", async () => {
      vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockResolvedValue({
        id: "pay_preflight_001",
        entity: "payment",
        amount: 299900,
        currency: "INR",
        status: "captured",
        order_id: "order_001",
        invoice_id: null,
        international: false,
        method: "card",
        amount_refunded: 0,
        refund_status: null,
        captured: true,
        created_at: Date.now(),
      });

      vi.spyOn(ordersMod, "fetchRazorpayOrder").mockResolvedValue({
        id: "order_001",
        amount: 299900,
        amount_paid: 299900,
        amount_due: 0,
        currency: "INR",
        status: "paid",
        attempts: 1,
      } as any);

      vi.spyOn(paymentsMod, "fetchPaymentsForOrder").mockResolvedValue([]);

      vi.spyOn(supabase, "from").mockReturnValue({
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any);

      const state: any = {
        caseId: "case_preflight_1",
        originalPaymentId: "pay_preflight_001",
        originalOrderId: "order_001",
      };

      const result = await preflightRevalidateNode(state);
      expect(result.terminalStatus).toBe("STOPPED_ALREADY_PAID");
    });
  });

  // Scenario J: Payment Link Network Uncertainty
  describe("Scenario J: Payment Link Network Uncertainty Reconciliation", () => {
    it("reconciles uncertain link by reference_id and adopts existing provider link without duplicate creation", async () => {
      vi.spyOn(linksMod, "findPaymentLinkByReferenceId").mockResolvedValue({
        id: "plink_reconciled_999",
        entity: "payment_link",
        amount: 299900,
        amount_paid: 0,
        currency: "INR",
        status: "created",
        reference_id: "rcv_case1234_1",
        short_url: "https://rzp.io/i/reconciled",
        created_at: Date.now(),
      });

      vi.spyOn(supabase, "from").mockReturnValue({
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      } as any);

      const state: any = {
        caseId: "case1234",
        action: {
          actionId: "act_1",
          referenceId: "rcv_case1234_1",
          status: "UNCERTAIN",
        },
      };

      const result = await reconcileLinkCreationNode(state);
      expect(result.action?.status).toBe("CREATED");
      expect(result.action?.paymentLinkId).toBe("plink_reconciled_999");
      expect(result.action?.shortUrl).toBe("https://rzp.io/i/reconciled");
    });
  });

  // Scenario L: Original Late Capture
  describe("Scenario L: Original Late Capture Cancellation", () => {
    it("cancels recovery payment link when original payment captures late", async () => {
      const cancelSpy = vi.spyOn(linksMod, "cancelPaymentLink").mockResolvedValue({
        id: "plink_to_cancel_1",
        status: "cancelled",
      } as any);

      vi.spyOn(supabase, "from").mockReturnValue({
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any);

      const state: any = {
        caseId: "case_late_cap",
        action: {
          paymentLinkId: "plink_to_cancel_1",
        },
      };

      const result = await handleOriginalLateCaptureNode(state);
      expect(result.terminalStatus).toBe("STOPPED_ALREADY_PAID");
      expect(cancelSpy).toHaveBeenCalledWith("plink_to_cancel_1");
    });
  });

  // Scenarios M, N, O, P, Q: Independent Verifier
  describe("Scenarios M through Q: Independent Verifier & Receipts", () => {
    it("Scenario M: False success (un-captured recovery payment) fails verification", async () => {
      vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockImplementation(async (id: string) => {
        if (id === "pay_uncaptured_recovery") {
          return {
            id: "pay_uncaptured_recovery",
            amount: 299900,
            currency: "INR",
            status: "failed",
            captured: false,
          } as any;
        }
        return {
          id: "pay_orig_1",
          amount: 299900,
          currency: "INR",
          status: "failed",
          captured: false,
        } as any;
      });

      vi.spyOn(linksMod, "fetchPaymentLink").mockResolvedValue({
        id: "plink_1",
        reference_id: "rcv_case1_1",
        status: "paid",
        amount: 299900,
        currency: "INR",
      } as any);

      vi.spyOn(supabase, "from").mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any);

      const state: any = {
        caseId: "case_false_success",
        originalPaymentId: "pay_orig_1",
        action: {
          paymentLinkId: "plink_1",
          recoveryPaymentId: "pay_uncaptured_recovery",
          referenceId: "rcv_case1_1",
        },
        gate: {
          exactAmountMinor: 299900,
          currency: "INR",
        },
      };

      const result = await verifyRecoveryNode(state);
      expect(result.terminalStatus).toBe("FAILED_SAFE");
      expect(result.verification?.status).toBe("FAILED");
    });

    it("Scenario N: Amount mismatch fails verification", async () => {
      vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockImplementation(async (id: string) => {
        if (id === "pay_mismatch_amount") {
          return {
            id: "pay_mismatch_amount",
            amount: 10000, // ₹100 instead of ₹2,999
            currency: "INR",
            status: "captured",
            captured: true,
          } as any;
        }
        return {
          id: "pay_orig_1",
          amount: 299900,
          currency: "INR",
          status: "failed",
          captured: false,
        } as any;
      });

      vi.spyOn(linksMod, "fetchPaymentLink").mockResolvedValue({
        id: "plink_1",
        reference_id: "rcv_case1_1",
        status: "paid",
        amount: 10000,
        currency: "INR",
      } as any);

      vi.spyOn(supabase, "from").mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any);

      const state: any = {
        caseId: "case_amount_mismatch",
        originalPaymentId: "pay_orig_1",
        action: {
          paymentLinkId: "plink_1",
          recoveryPaymentId: "pay_mismatch_amount",
          referenceId: "rcv_case1_1",
        },
        gate: {
          exactAmountMinor: 299900,
          currency: "INR",
        },
      };

      const result = await verifyRecoveryNode(state);
      expect(result.terminalStatus).toBe("FAILED_SAFE");
      expect(result.verification?.status).toBe("FAILED");
      const amountCheck = result.verification?.checks.find(
        (c: any) => c.key === "EXACT_AMOUNT_MATCH",
      );
      expect(amountCheck?.passed).toBe(false);
    });

    it("Scenario P: Double payment risk flagged when both original and recovery captured", async () => {
      vi.spyOn(paymentsMod, "fetchRazorpayPayment").mockImplementation(async (id: string) => {
        if (id === "pay_recovery_double") {
          return {
            id: "pay_recovery_double",
            amount: 299900,
            currency: "INR",
            status: "captured",
            captured: true,
          } as any;
        }
        return {
          id: "pay_orig_double",
          amount: 299900,
          currency: "INR",
          status: "captured", // Original also captured!
          captured: true,
        } as any;
      });

      vi.spyOn(linksMod, "fetchPaymentLink").mockResolvedValue({
        id: "plink_1",
        reference_id: "rcv_case1_1",
        status: "paid",
        amount: 299900,
        currency: "INR",
      } as any);

      vi.spyOn(supabase, "from").mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as any);

      const state: any = {
        caseId: "case_double_payment",
        originalPaymentId: "pay_orig_double",
        action: {
          paymentLinkId: "plink_1",
          recoveryPaymentId: "pay_recovery_double",
          referenceId: "rcv_case1_1",
        },
        gate: {
          exactAmountMinor: 299900,
          currency: "INR",
        },
      };

      const result = await verifyRecoveryNode(state);
      expect(result.terminalStatus).toBe("DOUBLE_PAYMENT_RISK");
      expect(result.verification?.status).toBe("DOUBLE_PAYMENT_RISK");
    });

    it("Scenario Q: Verification receipt is immutable and does not downgrade", async () => {
      vi.spyOn(supabase, "from").mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: "receipt_immutable_1",
                  status: "VERIFIED",
                  checks_passed: [{ key: "ALL_PASSED", passed: true }],
                },
                error: null,
              }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      } as any);

      const state: any = {
        caseId: "case_already_verified",
        originalPaymentId: "pay_orig_1",
        action: {
          paymentLinkId: "plink_1",
          recoveryPaymentId: "pay_rec_1",
        },
      };

      const result = await verifyRecoveryNode(state);
      expect(result.terminalStatus).toBe("RECOVERED_VERIFIED");
      expect(result.verification?.status).toBe("VERIFIED");
      expect(result.verification?.receiptId).toBe("receipt_immutable_1");
    });
  });
});
