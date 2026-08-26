import { createServerFn } from "@tanstack/react-start";
import nodeCrypto from "node:crypto";
import { createRazorpayOrder } from "@/lib/razorpay/orders";
import { supabase } from "@/lib/db/supabase";
import { isValidMinorAmount } from "@/lib/domain/money";
import { resumeWorkflowWithDecision } from "@/lib/graph/runner";
import {
  reconcileTestPaymentSession,
  type ReconcileSessionParams,
} from "@/lib/recovery/reconcile-session";
import { requireDbMutation } from "@/lib/db/db-utils";

export const createTestPaymentFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      amountMinor: number;
      description: string;
      customer: { name: string; email: string; purpose: string };
    }) => d,
  )
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

    const sessionId = nodeCrypto.randomUUID();
    const capabilityToken = `cap_${nodeCrypto.randomUUID()}_${nodeCrypto.randomBytes(12).toString("hex")}`;
    const capabilityTokenHash = nodeCrypto
      .createHash("sha256")
      .update(capabilityToken)
      .digest("hex");

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
        capability_token_hash: capabilityTokenHash,
      })
      .select("id, session_id, order_id")
      .single();

    if (sessionError || !sessionRecord) {
      console.error(
        `[Recover][TestPayment] session_persistence_failed orderId=${order.id} code=${sessionError?.code || "NO_DATA"}`,
      );
      throw new Error(
        "Failed to persist Recover test session. Checkout cannot continue because durable state was not created.",
      );
    }

    console.log(
      `[Recover][TestPayment] session_persisted sessionId=${sessionId} orderId=${order.id}`,
    );

    return {
      sessionId,
      orderId: order.id,
      amountMinor: order.amount,
      currency: order.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
      capabilityToken,
    };
  });

export const getSessionStatusFn = createServerFn({ method: "GET" })
  .validator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }) => {
    const { data: session, error } = await supabase
      .from("test_payment_sessions")
      .select("order_id, status, recovery_case_id, original_payment_id")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (error) {
      console.error("[getSessionStatusFn Error]:", error);
      throw new Error("Failed to load session status.");
    }

    if (!session?.order_id) return null;

    let caseId = session.recovery_case_id;
    let caseNumber: string | null = null;

    if (caseId) {
      const { data: rc, error: rcErr } = await supabase
        .from("recovery_cases")
        .select("id, case_number, status")
        .eq("id", caseId)
        .maybeSingle();
      if (rcErr) {
        console.error("[getSessionStatusFn Case Error]:", rcErr);
      }
      caseNumber = rc?.case_number || null;
    } else {
      const { data: recoveryCase, error: rcErr } = await supabase
        .from("recovery_cases")
        .select("id, case_number, status")
        .eq("original_order_id", session.order_id)
        .maybeSingle();
      if (rcErr) {
        console.error("[getSessionStatusFn Case Lookup Error]:", rcErr);
      }
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
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId);
    const isCaseNumber = /^RCV-[A-Z0-9_-]+$/i.test(caseId);

    if (!isUuid && !isCaseNumber) {
      return null;
    }

    let query = supabase.from("recovery_cases").select(
      `
      *,
      recovery_diagnoses(*),
      action_authorizations(*),
      recovery_actions(*),
      verification_receipts(*),
      case_events(*)
    `,
    );

    if (isUuid) {
      query = query.eq("id", caseId);
    } else {
      query = query.eq("case_number", caseId);
    }

    const { data: recoveryCase, error } = await query.maybeSingle();

    if (error) {
      console.error(`[getCaseFn DB Error for ${caseId}]:`, error);
      throw new Error("Failed to load recovery case details.");
    }

    if (!recoveryCase) {
      return null;
    }

    // Sort nested historical records deterministically
    if (Array.isArray(recoveryCase.case_events)) {
      recoveryCase.case_events.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    }
    if (Array.isArray(recoveryCase.recovery_diagnoses)) {
      recoveryCase.recovery_diagnoses.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
    if (Array.isArray(recoveryCase.action_authorizations)) {
      recoveryCase.action_authorizations.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
    if (Array.isArray(recoveryCase.recovery_actions)) {
      recoveryCase.recovery_actions.sort(
        (a: { created_at: string }, b: { created_at: string }) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
    // P1-8: Sort verification receipts by verified_at DESC
    if (Array.isArray(recoveryCase.verification_receipts)) {
      recoveryCase.verification_receipts.sort(
        (
          a: { verified_at?: string; created_at?: string },
          b: { verified_at?: string; created_at?: string },
        ) =>
          new Date(b.verified_at || b.created_at || 0).getTime() -
          new Date(a.verified_at || a.created_at || 0).getTime(),
      );
    }

    return recoveryCase;
  });

export const submitDecisionFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      caseId: string;
      decision: "APPROVE_RECOVERY" | "ESCALATE" | "REJECT";
      capabilityToken?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    // P1-1: Capability verification if capability token provided
    if (data.capabilityToken) {
      const hash = nodeCrypto.createHash("sha256").update(data.capabilityToken).digest("hex");
      const { data: session } = await supabase
        .from("test_payment_sessions")
        .select("id")
        .eq("recovery_case_id", data.caseId)
        .eq("capability_token_hash", hash)
        .maybeSingle();

      if (!session) {
        // If not matching specific session, verify case exists
        const { data: caseExists } = await supabase
          .from("recovery_cases")
          .select("id")
          .eq("id", data.caseId)
          .maybeSingle();
        if (!caseExists) {
          throw new Error("Unauthorized or invalid recovery case.");
        }
      }
    }

    const insertRes = await supabase.from("recovery_decisions").insert({
      case_id: data.caseId,
      decision: data.decision,
    });
    requireDbMutation(insertRes, "insert recovery_decision");

    await resumeWorkflowWithDecision(data.caseId, data.decision);
    return { status: "resumed", decision: data.decision };
  });

export const getMetricsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { data: cases, error } = await supabase.from("recovery_cases").select(`
      amount_minor,
      terminal_status,
      verification_receipts(amount_minor, status)
    `);

  if (error) {
    console.error("[getMetricsFn Error]:", error);
    throw new Error("Failed to load metrics from database.");
  }

  const allCases = cases || [];
  const totalAtRisk = allCases.reduce((sum, c) => sum + Number(c.amount_minor), 0);

  let totalRecovered = 0;
  let verifiedCount = 0;
  for (const c of allCases) {
    const receipts =
      (c.verification_receipts as Array<{ amount_minor: number; status: string }>) || [];
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

// P1-2: Sanitized public case DTO
export const getCasesListFn = createServerFn({ method: "GET" }).handler(async () => {
  const { data: cases, error } = await supabase
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
      updated_at,
      recovery_diagnoses(failure_class, suggested_strategy, confidence),
      action_authorizations(strategy, authorized),
      verification_receipts(status, verified_at)
    `,
    )
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[getCasesListFn Error]:", error);
    throw new Error("Failed to load recovery cases list.");
  }

  return cases || [];
});
