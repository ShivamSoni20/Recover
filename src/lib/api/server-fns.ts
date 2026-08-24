import { createServerFn } from "@tanstack/react-start";
import { createRazorpayOrder } from "@/lib/razorpay/orders";
import { supabase } from "@/lib/db/supabase";
import { isValidMinorAmount } from "@/lib/domain/money";
import { resumeWorkflowWithDecision } from "@/lib/graph/runner";
import { reconcileTestPaymentSession, type ReconcileSessionParams } from "@/lib/recovery/reconcile-session";
import { requireDbMutation } from "@/lib/db/db-utils";

export const createTestPaymentFn = createServerFn({ method: "POST" })
  .validator((d: {
    amountMinor: number;
    description: string;
    customer: { name: string; email: string; purpose: string };
  }) => d)
  .handler(async ({ data }) => {
    const { amountMinor, description, customer } = data;

    if (!isValidMinorAmount(amountMinor, 10000, 1000000)) {
      throw new Error("Amount must be between ₹100 and ₹10,000 in Test Mode.");
    }

    const receipt = `rcv_sess_${Date.now()}`;
    const order = await createRazorpayOrder({
      amountMinor,
      currency: "INR",
      receipt,
      notes: {
        customer_name: customer?.name || "",
        customer_email: customer?.email || "",
        customer_purpose: customer?.purpose || "",
        description: description || "Recover Test Payment",
      },
    });

    console.log(`[Recover][TestPayment] order_created orderId=${order.id}`);

    const sessionId = crypto.randomUUID();
    const { data: sessionRecord, error: sessionError } = await supabase
      .from("test_payment_sessions")
      .insert({
        session_id: sessionId,
        order_id: order.id,
        amount_minor: amountMinor,
        currency: "INR",
        description,
        customer_name: customer?.name,
        customer_email: customer?.email,
        customer_purpose: customer?.purpose,
        status: "CREATED",
      })
      .select("id, session_id, order_id")
      .single();

    if (sessionError || !sessionRecord) {
      console.error(`[Recover][TestPayment] session_persistence_failed orderId=${order.id} code=${sessionError?.code || "NO_DATA"}`);
      throw new Error("Failed to persist Recover test session. Checkout cannot continue because durable state was not created.");
    }

    console.log(`[Recover][TestPayment] session_persisted sessionId=${sessionId} orderId=${order.id}`);

    return {
      sessionId,
      orderId: order.id,
      amountMinor: order.amount,
      currency: order.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
    };
  });

export const getSessionStatusFn = createServerFn({ method: "GET" })
  .validator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }) => {
    const { data: session } = await supabase
      .from("test_payment_sessions")
      .select("order_id, status, recovery_case_id, original_payment_id")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (!session?.order_id) return null;

    let caseId = session.recovery_case_id;
    let caseNumber: string | null = null;

    if (caseId) {
      const { data: rc } = await supabase
        .from("recovery_cases")
        .select("id, case_number, status")
        .eq("id", caseId)
        .maybeSingle();
      caseNumber = rc?.case_number || null;
    } else {
      const { data: recoveryCase } = await supabase
        .from("recovery_cases")
        .select("id, case_number, status")
        .eq("original_order_id", session.order_id)
        .maybeSingle();
      if (recoveryCase) {
        caseId = recoveryCase.id;
        caseNumber = recoveryCase.case_number;
      }
    }

    return {
      orderId: session.order_id,
      sessionStatus: session.status,
      caseId: caseId || null,
      caseNumber: caseNumber || null,
    };
  });

export const reconcileTestPaymentSessionFn = createServerFn({ method: "POST" })
  .validator((d: ReconcileSessionParams) => d)
  .handler(async ({ data }) => {
    return await reconcileTestPaymentSession(data);
  });

export const getCaseFn = createServerFn({ method: "GET" })
  .validator((caseId: string) => caseId)
  .handler(async ({ data: caseId }) => {
    const { data: recoveryCase, error } = await supabase
      .from("recovery_cases")
      .select(`
        *,
        recovery_diagnoses(*),
        action_authorizations(*),
        recovery_actions(*),
        verification_receipts(*),
        case_events(*)
      `)
      .or(`id.eq.${caseId},case_number.eq.${caseId}`)
      .maybeSingle();

    if (error || !recoveryCase) {
      return null;
    }

    // Sort nested historical records deterministically
    if (Array.isArray(recoveryCase.case_events)) {
      recoveryCase.case_events.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    }
    if (Array.isArray(recoveryCase.recovery_diagnoses)) {
      recoveryCase.recovery_diagnoses.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    }
    if (Array.isArray(recoveryCase.action_authorizations)) {
      recoveryCase.action_authorizations.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    }
    if (Array.isArray(recoveryCase.recovery_actions)) {
      recoveryCase.recovery_actions.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    }
    if (Array.isArray(recoveryCase.verification_receipts)) {
      recoveryCase.verification_receipts.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    }

    return recoveryCase;
  });

export const submitDecisionFn = createServerFn({ method: "POST" })
  .validator((d: { caseId: string; decision: "APPROVE_RECOVERY" | "ESCALATE" | "REJECT" }) => d)
  .handler(async ({ data }) => {
    const insertRes = await supabase.from("recovery_decisions").insert({
      case_id: data.caseId,
      decision: data.decision,
    });
    requireDbMutation(insertRes, "insert recovery_decision");

    await resumeWorkflowWithDecision(data.caseId, data.decision);
    return { status: "resumed", decision: data.decision };
  });

export const getMetricsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { data: cases } = await supabase
    .from("recovery_cases")
    .select(`
      amount_minor,
      terminal_status,
      verification_receipts(amount_minor, status)
    `);

  const allCases = cases || [];
  const totalAtRisk = allCases.reduce((sum, c) => sum + Number(c.amount_minor), 0);

  let totalRecovered = 0;
  let verifiedCount = 0;
  for (const c of allCases) {
    const receipts = (c.verification_receipts as Array<{ amount_minor: number; status: string }>) || [];
    const verifiedReceipt = receipts.find((r) => r.status === "VERIFIED");
    if (verifiedReceipt && c.terminal_status === "RECOVERED_VERIFIED") {
      totalRecovered += Number(verifiedReceipt.amount_minor);
      verifiedCount++;
    }
  }

  const safeStops = allCases.filter((c) => c.terminal_status === "STOPPED_ALREADY_PAID").length;
  const manualReviewCount = allCases.filter((c) => c.terminal_status === "MANUAL_REVIEW").length;
  const recoveryRate = totalAtRisk > 0 ? Math.round((totalRecovered / totalAtRisk) * 100) : 0;

  return {
    casesCount: allCases.length,
    totalAtRiskMinor: totalAtRisk,
    totalRecoveredMinor: totalRecovered,
    recoveryRate,
    safeStops,
    manualReviewCount,
  };
});

export const getCasesListFn = createServerFn({ method: "GET" }).handler(async () => {
  const { data: cases } = await supabase
    .from("recovery_cases")
    .select(`
      *,
      recovery_diagnoses(*),
      action_authorizations(*),
      recovery_actions(*),
      verification_receipts(*)
    `)
    .order("created_at", { ascending: false });

  return cases || [];
});
