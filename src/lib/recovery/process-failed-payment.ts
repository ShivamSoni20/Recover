import { fetchRazorpayPayment, type RazorpayPaymentResponse } from "@/lib/razorpay/payments";
import { supabase } from "@/lib/db/supabase";
import { startRecoveryWorkflow, ensureRecoveryWorkflowStarted } from "@/lib/graph/runner";
import { requireDbMutation } from "@/lib/db/db-utils";

export type FailureProvenance = "WEBHOOK" | "CANONICAL_API_RECONCILIATION";

export interface ProcessFailedPaymentParams {
  paymentId: string;
  orderId?: string;
  provenance: FailureProvenance;
  canonicalPayment?: RazorpayPaymentResponse;
}

export interface ProcessFailedPaymentResult {
  success: boolean;
  caseId: string;
  caseNumber: string;
  isNew: boolean;
  paymentId: string;
}

export async function processCanonicalFailedPayment(
  params: ProcessFailedPaymentParams
): Promise<ProcessFailedPaymentResult> {
  const { paymentId, orderId, provenance } = params;

  // 1. Fetch canonical Razorpay payment if not pre-provided
  const payment = params.canonicalPayment ?? (await fetchRazorpayPayment(paymentId));
  if (!payment) {
    throw new Error(`Razorpay payment '${paymentId}' not found.`);
  }

  // 2. Security & Integrity Verifications: Provider Truth Only
  if (payment.status !== "failed") {
    throw new Error(
      `Cannot process recovery for payment '${payment.id}': canonical status is '${payment.status}', expected 'failed'.`
    );
  }

  if (orderId && payment.order_id && payment.order_id !== orderId) {
    throw new Error(
      `Payment '${payment.id}' order mismatch: belongs to '${payment.order_id}', expected '${orderId}'.`
    );
  }

  const effectiveOrderId = payment.order_id || orderId;

  // 3. Check existing case by original_payment_id (Idempotency)
  const { data: existingPaymentCase } = await supabase
    .from("recovery_cases")
    .select("id, case_number, status")
    .eq("original_payment_id", payment.id)
    .maybeSingle();

  if (existingPaymentCase) {
    // Repair session link
    if (effectiveOrderId) {
      const updateRes = await supabase
        .from("test_payment_sessions")
        .update({
          status: "FAILED",
          original_payment_id: payment.id,
          recovery_case_id: existingPaymentCase.id,
          updated_at: new Date().toISOString(),
        })
        .eq("order_id", effectiveOrderId);
      requireDbMutation(updateRes, "update test_payment_sessions for existing payment case");
    }

    // Ensure LangGraph workflow is started even on retry
    await ensureRecoveryWorkflowStarted({
      caseId: existingPaymentCase.id,
      originalOrderId: effectiveOrderId || "",
      originalPaymentId: payment.id,
    });

    return {
      success: true,
      caseId: existingPaymentCase.id,
      caseNumber: existingPaymentCase.case_number,
      isNew: false,
      paymentId: payment.id,
    };
  }

  // Also check if existing case exists by original_order_id
  if (effectiveOrderId) {
    const { data: existingOrderCase } = await supabase
      .from("recovery_cases")
      .select("id, case_number, status")
      .eq("original_order_id", effectiveOrderId)
      .maybeSingle();

    if (existingOrderCase) {
      const updateRes = await supabase
        .from("test_payment_sessions")
        .update({
          status: "FAILED",
          original_payment_id: payment.id,
          recovery_case_id: existingOrderCase.id,
          updated_at: new Date().toISOString(),
        })
        .eq("order_id", effectiveOrderId);
      requireDbMutation(updateRes, "update test_payment_sessions for existing order case");

      await ensureRecoveryWorkflowStarted({
        caseId: existingOrderCase.id,
        originalOrderId: effectiveOrderId,
        originalPaymentId: payment.id,
      });

      return {
        success: true,
        caseId: existingOrderCase.id,
        caseNumber: existingOrderCase.case_number,
        isNew: false,
        paymentId: payment.id,
      };
    }
  }

  // 4. Create new recovery case
  const caseId = crypto.randomUUID();
  const caseNumber = `RCV-${Math.floor(10000 + Math.random() * 89999)}`;

  const { error: insertError } = await supabase.from("recovery_cases").insert({
    id: caseId,
    case_number: caseNumber,
    thread_id: caseId,
    original_order_id: effectiveOrderId || "unknown",
    original_payment_id: payment.id,
    amount_minor: payment.amount,
    currency: payment.currency,
    customer_email: payment.email,
    customer_name: payment.notes?.customer_name,
    customer_purpose: payment.notes?.customer_purpose,
    description: payment.notes?.description || payment.description || "Recover Demo Payment",
    failure_reason: payment.error_reason || payment.error_code || "Payment Failed",
    failure_detail: payment.error_description || "Transaction failed at gateway",
    method: payment.method,
    failed_at: new Date().toISOString(),
    status: "PAYMENT_FAILED",
  });

  if (insertError) {
    // Handle race condition (concurrent webhook & polling reconciliation)
    if (insertError.code === "23505" || insertError.message?.includes("duplicate")) {
      const { data: racedCase } = await supabase
        .from("recovery_cases")
        .select("id, case_number")
        .or(`original_payment_id.eq.${payment.id},original_order_id.eq.${effectiveOrderId}`)
        .maybeSingle();

      if (racedCase) {
        if (effectiveOrderId) {
          await supabase
            .from("test_payment_sessions")
            .update({
              status: "FAILED",
              original_payment_id: payment.id,
              recovery_case_id: racedCase.id,
              updated_at: new Date().toISOString(),
            })
            .eq("order_id", effectiveOrderId);
        }

        await ensureRecoveryWorkflowStarted({
          caseId: racedCase.id,
          originalOrderId: effectiveOrderId || "",
          originalPaymentId: payment.id,
        });

        return {
          success: true,
          caseId: racedCase.id,
          caseNumber: racedCase.case_number,
          isNew: false,
          paymentId: payment.id,
        };
      }
    }
    throw new Error(`Failed to create recovery case: ${insertError.message}`);
  }

  // 5. Update session tracking
  if (effectiveOrderId) {
    const sessionUpdate = await supabase
      .from("test_payment_sessions")
      .update({
        status: "FAILED",
        original_payment_id: payment.id,
        recovery_case_id: caseId,
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", effectiveOrderId);
    requireDbMutation(sessionUpdate, "link recovery case to test_payment_sessions");
  }

  // 6. Insert audit case event with exact provenance
  const eventInsert = await supabase.from("case_events").insert({
    case_id: caseId,
    event_type:
      provenance === "WEBHOOK"
        ? "PAYMENT_FAILED_WEBHOOK_VERIFIED"
        : "PAYMENT_FAILED_CANONICALLY_RECONCILED",
    label:
      provenance === "WEBHOOK"
        ? "Payment failure confirmed via signed webhook"
        : "Payment failure canonically verified via Razorpay API",
    data: {
      paymentId: payment.id,
      orderId: effectiveOrderId,
      provenance,
      method: payment.method,
      errorCode: payment.error_code,
      errorDescription: payment.error_description,
      errorReason: payment.error_reason,
      errorSource: payment.error_source,
      errorStep: payment.error_step,
    },
  });
  requireDbMutation(eventInsert, "insert initial case_event");

  // 7. Start durable LangGraph workflow exactly once
  await startRecoveryWorkflow({
    caseId,
    originalOrderId: effectiveOrderId || "",
    originalPaymentId: payment.id,
  });

  return {
    success: true,
    caseId,
    caseNumber,
    isNew: true,
    paymentId: payment.id,
  };
}
