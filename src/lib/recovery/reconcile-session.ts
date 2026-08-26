import { supabase } from "@/lib/db/supabase";
import {
  fetchPaymentsForOrder,
  fetchRazorpayPayment,
  type RazorpayPaymentResponse,
} from "@/lib/razorpay/payments";
import { processCanonicalFailedPayment } from "./process-failed-payment";

export interface ReconcileSessionParams {
  sessionId: string;
  candidatePaymentId?: string;
}

export type ReconcileSessionResult =
  | {
      status: "FAILURE_CONFIRMED";
      caseId: string;
      caseNumber: string;
      paymentId?: string;
    }
  | {
      status: "PAYMENT_SUCCEEDED";
      paymentId?: string;
      message: string;
    }
  | {
      status: "PAYMENT_AUTHORIZED";
      paymentId?: string;
      message: string;
    }
  | {
      status: "PAYMENT_PENDING";
      paymentStatus: string;
      paymentId?: string;
    }
  | {
      status: "SESSION_NOT_FOUND" | "NO_PAYMENT_ATTEMPT_FOUND";
      message: string;
    };

export async function reconcileTestPaymentSession(
  params: ReconcileSessionParams,
): Promise<ReconcileSessionResult> {
  const { sessionId, candidatePaymentId } = params;

  const { data: session } = await supabase
    .from("test_payment_sessions")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (!session || !session.order_id) {
    return {
      status: "SESSION_NOT_FOUND",
      message: "Test session could not be found.",
    };
  }

  // 1. If recovery case already exists in DB, return immediately
  if (session.recovery_case_id) {
    const { data: rc } = await supabase
      .from("recovery_cases")
      .select("id, case_number")
      .eq("id", session.recovery_case_id)
      .maybeSingle();
    if (rc) {
      return {
        status: "FAILURE_CONFIRMED",
        caseId: rc.id,
        caseNumber: rc.case_number,
        paymentId: session.original_payment_id || undefined,
      };
    }
  }

  const { data: existingCase } = await supabase
    .from("recovery_cases")
    .select("id, case_number, original_payment_id")
    .eq("original_order_id", session.order_id)
    .maybeSingle();

  if (existingCase) {
    return {
      status: "FAILURE_CONFIRMED",
      caseId: existingCase.id,
      caseNumber: existingCase.case_number,
      paymentId: existingCase.original_payment_id || undefined,
    };
  }

  // 2. Fetch canonical payments for order from Razorpay
  const payments = await fetchPaymentsForOrder(session.order_id);

  let targetPayment: RazorpayPaymentResponse | undefined;

  // Prefer candidatePaymentId if supplied and valid
  if (candidatePaymentId) {
    targetPayment = payments.find((p) => p.id === candidatePaymentId);
    if (!targetPayment) {
      try {
        const directPayment = await fetchRazorpayPayment(candidatePaymentId);
        if (directPayment && directPayment.order_id === session.order_id) {
          targetPayment = directPayment;
        }
      } catch {
        // Ignore and fall back to order list
      }
    }
  }

  // Fall back to newest payment attempt
  if (!targetPayment && payments.length > 0) {
    const sorted = [...payments].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    targetPayment = sorted[0];
  }

  if (!targetPayment) {
    return {
      status: "NO_PAYMENT_ATTEMPT_FOUND",
      message: "No payment attempts found for this order on Razorpay.",
    };
  }

  // 3. Handle terminal and non-terminal states
  if (targetPayment.status === "failed") {
    const result = await processCanonicalFailedPayment({
      orderId: session.order_id,
      paymentId: targetPayment.id,
      provenance: "CANONICAL_API_RECONCILIATION",
      canonicalPayment: targetPayment,
    });

    return {
      status: "FAILURE_CONFIRMED",
      caseId: result.caseId,
      caseNumber: result.caseNumber,
      paymentId: targetPayment.id,
    };
  }

  if (targetPayment.status === "captured") {
    await supabase
      .from("test_payment_sessions")
      .update({
        status: "PAID",
        original_payment_id: targetPayment.id,
        updated_at: new Date().toISOString(),
      })
      .eq("session_id", sessionId);

    return {
      status: "PAYMENT_SUCCEEDED",
      paymentId: targetPayment.id,
      message: "Payment succeeded on Razorpay. No recovery was required.",
    };
  }

  if (targetPayment.status === "authorized") {
    return {
      status: "PAYMENT_AUTHORIZED",
      paymentId: targetPayment.id,
      message: "Payment is authorized on Razorpay.",
    };
  }

  return {
    status: "PAYMENT_PENDING",
    paymentStatus: targetPayment.status,
    paymentId: targetPayment.id,
  };
}
