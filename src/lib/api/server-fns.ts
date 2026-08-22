import { createServerFn } from "@tanstack/react-start";
import { createRazorpayOrder } from "@/lib/razorpay/orders";
import { supabase } from "@/lib/db/supabase";
import { isValidMinorAmount } from "@/lib/domain/money";
import { resumeWorkflowWithDecision } from "@/lib/graph/runner";

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

    const sessionId = crypto.randomUUID();
    await supabase.from("test_payment_sessions").insert({
      session_id: sessionId,
      order_id: order.id,
      amount_minor: amountMinor,
      currency: "INR",
      description,
      customer_name: customer?.name,
      customer_email: customer?.email,
      customer_purpose: customer?.purpose,
      status: "CREATED",
    });

    return {
      sessionId,
      orderId: order.id,
      amountMinor: order.amount,
      currency: order.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
    };
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
    return recoveryCase;
  });

export const submitDecisionFn = createServerFn({ method: "POST" })
  .validator((d: { caseId: string; decision: "APPROVE_RECOVERY" | "ESCALATE" | "REJECT" }) => d)
  .handler(async ({ data }) => {
    await supabase.from("recovery_decisions").insert({
      case_id: data.caseId,
      decision: data.decision,
    });
    await resumeWorkflowWithDecision(data.caseId, data.decision);
    return { status: "resumed", decision: data.decision };
  });

export const getMetricsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { data: cases } = await supabase
    .from("recovery_cases")
    .select("amount_minor, terminal_status");

  const allCases = cases || [];
  const totalAtRisk = allCases.reduce((sum, c) => sum + Number(c.amount_minor), 0);
  const verifiedCases = allCases.filter((c) => c.terminal_status === "RECOVERED_VERIFIED");
  const totalRecovered = verifiedCases.reduce((sum, c) => sum + Number(c.amount_minor), 0);
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
