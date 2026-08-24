import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { RecoverStateAnnotation, type RecoverState } from "./state";
import { fetchRazorpayOrder } from "../razorpay/orders";
import { fetchRazorpayPayment, fetchPaymentsForOrder } from "../razorpay/payments";
import {
  createRecoveryPaymentLink,
  fetchPaymentLink,
  cancelPaymentLink,
  findPaymentLinkByReferenceId,
} from "../razorpay/payment-links";
import { evaluateRecoveryGate, computeCanonicalStateHash } from "../domain/recovery-gate";
import { getActiveRecoveryPolicy } from "../domain/recovery-policy";
import { getRecoverModel } from "../ai/model";
import { DiagnosisOutputSchema, ProposalOutputSchema } from "../ai/schemas";
import { retrieveRecoveryKnowledge } from "../ai/rag-retriever";
import { supabase } from "../db/supabase";
import { requireDbMutation, requireDbSuccess } from "../db/db-utils";

async function updateCaseStatus(
  caseId: string,
  status: string,
  terminalStatus?: string
): Promise<void> {
  const updatePayload: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (terminalStatus) {
    updatePayload.terminal_status = terminalStatus;
  }
  const res = await supabase.from("recovery_cases").update(updatePayload).eq("id", caseId);
  requireDbMutation(res, `update case status to ${status}`);
}

// ----------------------------------------------------------------------------
// 1. canonicalize_original_state
// ----------------------------------------------------------------------------
export async function canonicalizeOriginalState(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "CANONICALIZING");
  const payment = await fetchRazorpayPayment(state.originalPaymentId);
  let order = undefined;
  let orderPayments: Array<{ id: string; status: string; captured: boolean; amountMinor: number }> = [];

  if (payment.order_id) {
    const rawOrder = await fetchRazorpayOrder(payment.order_id);
    order = {
      id: rawOrder.id,
      amountMinor: rawOrder.amount,
      amountPaidMinor: rawOrder.amount_paid,
      amountDueMinor: rawOrder.amount_due,
      currency: rawOrder.currency,
      status: rawOrder.status,
      attempts: rawOrder.attempts,
    };

    const rawOrderPayments = await fetchPaymentsForOrder(payment.order_id);
    orderPayments = rawOrderPayments.map((p) => ({
      id: p.id,
      status: p.status,
      captured: p.captured || p.status === "captured",
      amountMinor: p.amount,
    }));
  }

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "CANONICAL_PAYMENT_FETCHED",
    label: "Canonical state loaded",
    data: { paymentId: payment.id, status: payment.status, amount: payment.amount },
  });
  requireDbMutation(eventRes, "insert CANONICAL_PAYMENT_FETCHED event");

  return {
    canonicalOrder: order,
    canonicalPayment: {
      id: payment.id,
      orderId: payment.order_id,
      amountMinor: payment.amount,
      currency: payment.currency,
      status: payment.status,
      captured: payment.captured || payment.status === "captured",
      method: payment.method,
      errorCode: payment.error_code,
      errorDescription: payment.error_description,
      errorSource: payment.error_source,
      errorStep: payment.error_step,
      errorReason: payment.error_reason,
    },
    orderPayments,
  };
}

// ----------------------------------------------------------------------------
// 2. check_already_paid
// ----------------------------------------------------------------------------
export async function checkAlreadyPaid(state: RecoverState): Promise<Partial<RecoverState>> {
  const isCaptured = state.canonicalPayment?.captured;
  const isOrderPaid =
    state.canonicalOrder &&
    state.canonicalOrder.amountPaidMinor >= (state.canonicalPayment?.amountMinor || 0);
  const hasSiblingCaptured = state.orderPayments.some(
    (p) => p.id !== state.originalPaymentId && p.captured
  );

  if (isCaptured || isOrderPaid || hasSiblingCaptured) {
    await updateCaseStatus(state.caseId, "STOPPED_ALREADY_PAID", "STOPPED_ALREADY_PAID");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "STOPPED_ALREADY_PAID",
      label: "Payment already captured on provider",
      data: { isCaptured, isOrderPaid, hasSiblingCaptured },
    });
    requireDbMutation(eventRes, "insert STOPPED_ALREADY_PAID event");
    return { terminalStatus: "STOPPED_ALREADY_PAID" };
  }

  return {};
}

// ----------------------------------------------------------------------------
// 3. retrieve_knowledge
// ----------------------------------------------------------------------------
export async function retrieveKnowledgeNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "RETRIEVING_KNOWLEDGE");
  const query = `${state.canonicalPayment?.errorCode || ""} ${state.canonicalPayment?.errorDescription || ""} ${state.canonicalPayment?.method || ""}`.trim();
  const chunks = await retrieveRecoveryKnowledge(query || "payment failed");

  return {
    retrievedKnowledge: chunks.map((c) => ({
      chunkId: c.chunkId,
      source: c.source,
      content: c.content,
      score: c.score,
    })),
  };
}

// ----------------------------------------------------------------------------
// 4. diagnose_failure
// ----------------------------------------------------------------------------
export async function diagnoseFailureNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "DIAGNOSING");
  const model = getRecoverModel();
  const structuredModel = model.withStructuredOutput(DiagnosisOutputSchema);

  const knowledgeContext =
    state.retrievedKnowledge.length > 0
      ? state.retrievedKnowledge
          .map((k) => `[Source: ${k.source} | Score: ${Math.round(k.score * 100)}%]
${k.content}`)
          .join("\n\n")
      : "No domain knowledge chunks matched this error. Diagnose based strictly on provider facts.";

  const prompt = `You are Recover's AI Payment Failure Diagnostician.
Analyze the following payment failure from Razorpay Test Mode:

Payment ID: ${state.canonicalPayment?.id}
Error Code: ${state.canonicalPayment?.errorCode || "N/A"}
Error Description: ${state.canonicalPayment?.errorDescription || "N/A"}
Error Reason: ${state.canonicalPayment?.errorReason || "N/A"}
Payment Method: ${state.canonicalPayment?.method || "N/A"}
Amount: ${state.canonicalPayment?.amountMinor} ${state.canonicalPayment?.currency}

Relevant Knowledge Base:
${knowledgeContext}

Classify the failure strictly into one of the allowed categories.
Provide a high-confidence diagnosis summary and list evidence fields.`;

  const rawDiagnosis = await structuredModel.invoke(prompt);

  // Provenance Sanitization: Ensure knowledgeRefs are built only from verified retrieved sources
  const validSources = new Set(
    state.retrievedKnowledge.map((k) => k.source).filter(Boolean)
  );
  const sanitizedKnowledgeRefs = state.retrievedKnowledge.length > 0
    ? Array.from(validSources)
    : [];

  const diagnosis = {
    ...rawDiagnosis,
    knowledgeRefs: sanitizedKnowledgeRefs,
  };

  const diagRes = await supabase.from("recovery_diagnoses").insert({
    case_id: state.caseId,
    failure_class: diagnosis.failureClass,
    confidence: diagnosis.confidence,
    evidence_fields: diagnosis.evidenceFields,
    knowledge_refs: diagnosis.knowledgeRefs,
    summary: diagnosis.summary,
  });
  requireDbMutation(diagRes, "insert recovery_diagnoses");

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "AI_DIAGNOSIS_COMPLETED",
    label: `AI diagnosed: ${diagnosis.failureClass}`,
    data: { failureClass: diagnosis.failureClass, confidence: diagnosis.confidence, summary: diagnosis.summary },
  });
  requireDbMutation(eventRes, "insert AI_DIAGNOSIS_COMPLETED event");

  return { diagnosis };
}

// ----------------------------------------------------------------------------
// 5. propose_recovery
// ----------------------------------------------------------------------------
export async function proposeRecoveryNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "RECOVERY_PROPOSED");
  const model = getRecoverModel();
  const structuredModel = model.withStructuredOutput(ProposalOutputSchema);

  const prompt = `You are Recover's Autonomous Recovery Strategist.
Diagnosis: ${state.diagnosis?.failureClass} (${Math.round((state.diagnosis?.confidence || 0) * 100)}% confidence)
Diagnosis Summary: ${state.diagnosis?.summary}

Allowed strategies: FRESH_CHECKOUT, MANUAL_REVIEW, STOP_ALREADY_PAID.

Select the optimal recovery strategy. For standard customer-correctable, bank decline, network or payment method failures where payment is still unpaid, select FRESH_CHECKOUT.`;

  const rawProposal = await structuredModel.invoke(prompt);
  const proposal = {
    strategy: rawProposal.strategy,
    explanation: rawProposal.explanation,
    recommendedDelaySeconds: rawProposal.recommendedDelaySeconds ?? 0,
  };

  return { proposal };
}

// ----------------------------------------------------------------------------
// 6. recovery_gate
// ----------------------------------------------------------------------------
export async function recoveryGateNode(state: RecoverState): Promise<Partial<RecoverState>> {
  if (!state.canonicalPayment) throw new Error("Canonical payment missing in recovery gate.");

  const activePolicy = await getActiveRecoveryPolicy();

  // Count actual prior attempts for this case from Supabase
  const { data: existingActions } = await supabase
    .from("recovery_actions")
    .select("id, status")
    .eq("case_id", state.caseId);

  const attemptCount = (existingActions || []).filter((a) =>
    ["CREATING", "CREATED", "UNCERTAIN", "PAID", "CANCELLED", "FAILED"].includes(a.status)
  ).length;

  const gateResult = evaluateRecoveryGate({
    isTestMode: (process.env.RECOVER_RAZORPAY_MODE || "test") === "test",
    canonicalPayment: state.canonicalPayment,
    canonicalOrder: state.canonicalOrder,
    orderPayments: state.orderPayments,
    existingActiveAction: existingActions?.find((a) => ["CREATING", "CREATED", "UNCERTAIN"].includes(a.status)),
    attemptCount,
    failureClass: state.diagnosis?.failureClass || "UNKNOWN",
    confidence: state.diagnosis?.confidence || 0,
    proposedStrategy: state.proposal?.strategy || "MANUAL_REVIEW",
    policy: {
      maxRecoveryAttempts: activePolicy.maxRecoveryAttempts,
      maxAutonomousAmountMinor: activePolicy.maxAutonomousAmountMinor,
      requireApprovalAboveMinor: activePolicy.requireApprovalAboveMinor,
      allowFreshCheckout: activePolicy.allowFreshCheckout,
      minDiagnosisConfidence: activePolicy.minDiagnosisConfidence,
      blockRiskOrPolicyFailures: activePolicy.blockRiskOrPolicyFailures,
      blockUnknownFailures: activePolicy.blockUnknownFailures,
    },
  });

  // Cryptographic state hash & 30-minute validity window
  const canonicalStateHash = computeCanonicalStateHash({
    paymentId: state.canonicalPayment.id,
    paymentStatus: state.canonicalPayment.status,
    paymentCaptured: state.canonicalPayment.captured,
    paymentAmountMinor: state.canonicalPayment.amountMinor,
    paymentCurrency: state.canonicalPayment.currency,
    orderId: state.canonicalOrder?.id,
    orderStatus: state.canonicalOrder?.status,
    orderAmountPaidMinor: state.canonicalOrder?.amountPaidMinor,
    orderAmountDueMinor: state.canonicalOrder?.amountDueMinor,
    siblingPayments: state.orderPayments,
    policyVersionId: activePolicy.id,
  });

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const authInsert = await supabase
    .from("action_authorizations")
    .insert({
      case_id: state.caseId,
      policy_version_id: activePolicy.id,
      strategy: state.proposal?.strategy || "FRESH_CHECKOUT",
      exact_amount_minor: gateResult.exactAmountMinor,
      currency: gateResult.currency,
      canonical_state_hash: canonicalStateHash,
      authorized: gateResult.authorized,
      requires_approval: gateResult.requiresApproval,
      reason_codes: gateResult.reasonCodes,
      gate_checks: gateResult.gateChecks,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  const authRecord = requireDbSuccess(authInsert, "insert action_authorizations");

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: gateResult.authorized ? "RECOVERY_GATE_AUTHORIZED" : "RECOVERY_GATE_DENIED",
    label: gateResult.authorized ? "Recovery Gate authorized action" : "Recovery Gate denied action",
    data: { authorized: gateResult.authorized, reasonCodes: gateResult.reasonCodes },
  });
  requireDbMutation(eventRes, "insert recovery gate event");

  if (!gateResult.authorized) {
    await updateCaseStatus(state.caseId, "MANUAL_REVIEW", "MANUAL_REVIEW");
  }

  return {
    policyVersionId: activePolicy.id,
    action: {
      actionId: authRecord.id,
      referenceId: `rcv_${state.caseId.slice(0, 8)}_${attemptCount + 1}`,
      status: "NOT_STARTED",
    },
    gate: {
      authorized: gateResult.authorized,
      requiresApproval: gateResult.requiresApproval,
      reasonCodes: gateResult.reasonCodes,
      gateChecks: gateResult.gateChecks,
      exactAmountMinor: gateResult.exactAmountMinor,
      currency: gateResult.currency,
    },
    terminalStatus: gateResult.authorized ? undefined : "MANUAL_REVIEW",
  };
}

// ----------------------------------------------------------------------------
// 7A. mark_awaiting_approval (Side effects execute before interrupt)
// ----------------------------------------------------------------------------
export async function markAwaitingApprovalNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "WAITING_APPROVAL");
  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "AWAITING_APPROVAL",
    label: "Awaiting operator approval",
  });
  requireDbMutation(eventRes, "insert AWAITING_APPROVAL event");
  return {};
}

// ----------------------------------------------------------------------------
// 7B. await_approval_interrupt (Pure interrupt node with no side effects)
// ----------------------------------------------------------------------------
export async function awaitApprovalInterruptNode(state: RecoverState): Promise<Partial<RecoverState>> {
  const decision = interrupt({
    type: "RECOVERY_APPROVAL",
    caseId: state.caseId,
    failureClass: state.diagnosis?.failureClass,
    confidence: state.diagnosis?.confidence,
    strategy: state.proposal?.strategy,
    exactAmountMinor: state.gate?.exactAmountMinor,
    gateChecks: state.gate?.gateChecks,
  }) as { decision: "APPROVE_RECOVERY" | "ESCALATE" | "REJECT" };

  return {
    approval: {
      status: decision.decision === "APPROVE_RECOVERY" ? "APPROVED" : "ESCALATED",
      decisionBy: "operator",
    },
  };
}

// ----------------------------------------------------------------------------
// 7C. process_approval_decision (Durable side effects on resume)
// ----------------------------------------------------------------------------
export async function processApprovalDecisionNode(state: RecoverState): Promise<Partial<RecoverState>> {
  if (state.approval?.status === "APPROVED") {
    await updateCaseStatus(state.caseId, "RECOVERY_APPROVED");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "RECOVERY_APPROVED",
      label: "Recovery approved by operator",
    });
    requireDbMutation(eventRes, "insert RECOVERY_APPROVED event");
    return {};
  } else {
    await updateCaseStatus(state.caseId, "MANUAL_REVIEW", "MANUAL_REVIEW");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "MANUAL_REVIEW",
      label: "Escalated to manual review",
    });
    requireDbMutation(eventRes, "insert MANUAL_REVIEW event");
    return { terminalStatus: "MANUAL_REVIEW" };
  }
}

// ----------------------------------------------------------------------------
// 8. preflight_revalidate (Pre-action canonical check)
// ----------------------------------------------------------------------------
export async function preflightRevalidateNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "PREFLIGHT_CHECK");
  const payment = await fetchRazorpayPayment(state.originalPaymentId);
  let orderPaid = false;

  if (payment.order_id) {
    const rawOrder = await fetchRazorpayOrder(payment.order_id);
    const payments = await fetchPaymentsForOrder(payment.order_id);
    orderPaid = rawOrder.status === "paid" || payments.some((p) => p.captured || p.status === "captured");
  }

  if (payment.captured || payment.status === "captured" || orderPaid) {
    await updateCaseStatus(state.caseId, "STOPPED_ALREADY_PAID", "STOPPED_ALREADY_PAID");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "STOPPED_ALREADY_PAID",
      label: "Preflight detected original payment already captured",
    });
    requireDbMutation(eventRes, "insert STOPPED_ALREADY_PAID preflight event");
    return { terminalStatus: "STOPPED_ALREADY_PAID" };
  }

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "PREFLIGHT_REVALIDATED",
    label: "Preflight recheck passed: still unpaid",
  });
  requireDbMutation(eventRes, "insert PREFLIGHT_REVALIDATED event");

  return {};
}

// ----------------------------------------------------------------------------
// 9. create_recovery_link (With durable intent first)
// ----------------------------------------------------------------------------
export async function createRecoveryLinkNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "CREATING_RECOVERY_LINK");
  const referenceId = state.action?.referenceId || `rcv_${state.caseId.slice(0, 8)}_1`;

  // 1. Create durable intent record before external network call
  const intentUpsert = await supabase
    .from("recovery_actions")
    .upsert(
      {
        case_id: state.caseId,
        authorization_id: state.action?.actionId,
        reference_id: referenceId,
        amount_minor: state.gate!.exactAmountMinor,
        currency: state.gate!.currency,
        status: "CREATING",
      },
      { onConflict: "reference_id" }
    )
    .select("id")
    .single();

  const actionRow = requireDbSuccess(intentUpsert, "upsert recovery_actions intent");

  try {
    const link = await createRecoveryPaymentLink({
      amountMinor: state.gate!.exactAmountMinor,
      currency: state.gate!.currency,
      referenceId,
      description: `Recovery Checkout for ${state.originalOrderId || state.originalPaymentId}`,
      notes: {
        case_id: state.caseId,
        original_payment_id: state.originalPaymentId,
      },
    });

    const updateRes = await supabase
      .from("recovery_actions")
      .update({
        payment_link_id: link.id,
        short_url: link.short_url,
        status: "CREATED",
        updated_at: new Date().toISOString(),
      })
      .eq("reference_id", referenceId);
    requireDbMutation(updateRes, "update recovery_actions to CREATED");

    await updateCaseStatus(state.caseId, "RECOVERY_LINK_READY");

    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "PAYMENT_LINK_CREATED",
      label: "Recovery Payment Link created",
      data: { paymentLinkId: link.id, shortUrl: link.short_url, referenceId },
    });
    requireDbMutation(eventRes, "insert PAYMENT_LINK_CREATED event");

    return {
      action: {
        actionId: actionRow.id,
        referenceId,
        paymentLinkId: link.id,
        shortUrl: link.short_url,
        status: "CREATED",
      },
    };
  } catch (err) {
    console.error("[Create Link Uncertain Error]:", err);
    await supabase
      .from("recovery_actions")
      .update({ status: "UNCERTAIN" })
      .eq("reference_id", referenceId);

    return {
      action: {
        actionId: actionRow.id,
        referenceId,
        status: "UNCERTAIN",
      },
    };
  }
}

// ----------------------------------------------------------------------------
// 10. reconcile_link_creation (Handles uncertainty by querying referenceId)
// ----------------------------------------------------------------------------
export async function reconcileLinkCreationNode(state: RecoverState): Promise<Partial<RecoverState>> {
  const referenceId = state.action?.referenceId;
  if (!referenceId) return { terminalStatus: "FAILED_SAFE" };

  try {
    // 1. Check if recovery link was created by querying Razorpay by reference_id
    const link = await findPaymentLinkByReferenceId(referenceId);

    if (link) {
      const updateRes = await supabase
        .from("recovery_actions")
        .update({
          payment_link_id: link.id,
          short_url: link.short_url,
          status: "CREATED",
          updated_at: new Date().toISOString(),
        })
        .eq("reference_id", referenceId);
      requireDbMutation(updateRes, "reconcile recovery_actions to CREATED");

      await updateCaseStatus(state.caseId, "RECOVERY_LINK_READY");

      return {
        action: {
          ...state.action!,
          paymentLinkId: link.id,
          shortUrl: link.short_url,
          status: "CREATED",
        },
      };
    }
  } catch (err) {
    console.warn("[Reconcile Link Notice]:", err);
  }

  await updateCaseStatus(state.caseId, "FAILED_SAFE", "FAILED_SAFE");
  return { terminalStatus: "FAILED_SAFE" };
}

// ----------------------------------------------------------------------------
// 11A. mark_waiting_recovery_payment (Side effects before interrupt)
// ----------------------------------------------------------------------------
export async function markWaitingRecoveryPaymentNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "WAITING_RECOVERY_PAYMENT");
  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "WAITING_RECOVERY_PAYMENT",
    label: "Waiting for customer recovery payment",
  });
  requireDbMutation(eventRes, "insert WAITING_RECOVERY_PAYMENT event");
  return {};
}

// ----------------------------------------------------------------------------
// 11B. await_recovery_event_interrupt (Pure interrupt node)
// ----------------------------------------------------------------------------
export async function awaitRecoveryEventInterruptNode(state: RecoverState): Promise<Partial<RecoverState>> {
  const event = interrupt({
    type: "AWAIT_PAYMENT_EVENT",
    caseId: state.caseId,
    paymentLinkId: state.action?.paymentLinkId,
  }) as {
    kind?: "RECOVERY_PAYMENT_CAPTURED" | "ORIGINAL_PAYMENT_CAPTURED";
    eventType?: string;
    paymentId: string;
  };

  if (event.kind === "ORIGINAL_PAYMENT_CAPTURED") {
    return { terminalStatus: "STOPPED_ALREADY_PAID" };
  }

  return {
    action: {
      ...state.action!,
      status: "PAID",
      recoveryPaymentId: event.paymentId,
    },
  };
}

// ----------------------------------------------------------------------------
// 12. handle_original_late_capture (Cancels link if original payment captures)
// ----------------------------------------------------------------------------
export async function handleOriginalLateCaptureNode(state: RecoverState): Promise<Partial<RecoverState>> {
  if (state.action?.paymentLinkId) {
    try {
      await cancelPaymentLink(state.action.paymentLinkId);
    } catch {
      // Ignore if already cancelled or paid
    }
  }

  await updateCaseStatus(state.caseId, "STOPPED_ALREADY_PAID", "STOPPED_ALREADY_PAID");
  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "STOPPED_ALREADY_PAID",
    label: "Original payment captured late; recovery halted",
  });
  requireDbMutation(eventRes, "insert STOPPED_ALREADY_PAID late capture event");

  return { terminalStatus: "STOPPED_ALREADY_PAID" };
}

// ----------------------------------------------------------------------------
// 13. verify_recovery (Strict independent verification)
// ----------------------------------------------------------------------------
export async function verifyRecoveryNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "VERIFYING_RECOVERY");

  // Idempotency: Check if receipt is already VERIFIED
  const { data: existingReceipt } = await supabase
    .from("verification_receipts")
    .select("*")
    .eq("case_id", state.caseId)
    .eq("status", "VERIFIED")
    .maybeSingle();

  if (existingReceipt) {
    return {
      verification: {
        status: "VERIFIED",
        receiptId: existingReceipt.id,
        checks: existingReceipt.checks_passed as any,
      },
      terminalStatus: "RECOVERED_VERIFIED",
    };
  }

  const recoveryPaymentId = state.action?.recoveryPaymentId;
  const paymentLinkId = state.action?.paymentLinkId;

  if (!recoveryPaymentId || !paymentLinkId) {
    await updateCaseStatus(state.caseId, "FAILED_SAFE", "FAILED_SAFE");
    return { terminalStatus: "FAILED_SAFE" };
  }

  // 1. Independent Re-fetch of ALL relevant provider entities
  const recoveryPayment = await fetchRazorpayPayment(recoveryPaymentId);
  const paymentLink = await fetchPaymentLink(paymentLinkId);
  const originalPayment = await fetchRazorpayPayment(state.originalPaymentId);

  let originalOrderPayments: Array<{ id: string; status: string; captured: boolean; amount: number }> = [];
  if (originalPayment.order_id) {
    originalOrderPayments = await fetchPaymentsForOrder(originalPayment.order_id);
  }

  // 2. Perform strictly deterministic verification checks
  const checks = [
    {
      key: "RECOVERY_PAYMENT_CAPTURED",
      expected: true,
      observed: recoveryPayment.captured || recoveryPayment.status === "captured",
      passed: recoveryPayment.captured || recoveryPayment.status === "captured",
    },
    {
      key: "PAYMENT_LINK_PAID",
      expected: "paid",
      observed: paymentLink.status,
      passed: paymentLink.status === "paid",
    },
    {
      key: "PAYMENT_LINK_ID_MATCH",
      expected: paymentLinkId,
      observed: paymentLink.id,
      passed: paymentLink.id === paymentLinkId,
    },
    {
      key: "REFERENCE_ID_MATCH",
      expected: state.action?.referenceId,
      observed: paymentLink.reference_id,
      passed: paymentLink.reference_id === state.action?.referenceId,
    },
    {
      key: "EXACT_AMOUNT_MATCH",
      expected: state.gate?.exactAmountMinor,
      observed: recoveryPayment.amount,
      passed: recoveryPayment.amount === state.gate?.exactAmountMinor,
    },
    {
      key: "EXACT_CURRENCY_MATCH",
      expected: state.gate?.currency,
      observed: recoveryPayment.currency,
      passed: recoveryPayment.currency === state.gate?.currency,
    },
    {
      key: "ORIGINAL_PAYMENT_UNPAID",
      expected: false,
      observed: originalPayment.captured || originalPayment.status === "captured",
      passed: !(originalPayment.captured || originalPayment.status === "captured"),
    },
    {
      key: "NO_CAPTURED_ORIGINAL_SIBLINGS",
      expected: 0,
      observed: originalOrderPayments.filter((p) => p.id !== recoveryPayment.id && (p.captured || p.status === "captured")).length,
      passed: !originalOrderPayments.some((p) => p.id !== recoveryPayment.id && (p.captured || p.status === "captured")),
    },
  ];

  const allPassed = checks.every((c) => c.passed);
  const isDoublePayment =
    (originalPayment.captured || originalPayment.status === "captured") &&
    (recoveryPayment.captured || recoveryPayment.status === "captured");

  const receiptStatus = allPassed ? "VERIFIED" : isDoublePayment ? "DOUBLE_PAYMENT_RISK" : "FAILED";

  const receiptUpsert = await supabase.from("verification_receipts").upsert(
    {
      case_id: state.caseId,
      action_id: state.action?.actionId,
      recovery_payment_id: recoveryPayment.id,
      amount_minor: recoveryPayment.amount,
      currency: recoveryPayment.currency,
      checks_passed: checks,
      status: receiptStatus,
      verified_at: new Date().toISOString(),
    },
    { onConflict: "case_id" }
  );
  requireDbMutation(receiptUpsert, "upsert verification_receipts");

  const terminalStatus = allPassed
    ? "RECOVERED_VERIFIED"
    : isDoublePayment
      ? "DOUBLE_PAYMENT_RISK"
      : "FAILED_SAFE";

  await updateCaseStatus(state.caseId, terminalStatus, terminalStatus);

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: allPassed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED",
    label: allPassed ? "RECOVERED — VERIFIED" : `Verification outcome: ${receiptStatus}`,
    data: { status: receiptStatus, checks },
  });
  requireDbMutation(eventRes, "insert verification outcome event");

  return {
    verification: {
      status: receiptStatus,
      checks,
    },
    terminalStatus,
  };
}

// ----------------------------------------------------------------------------
// BUILD THE STATEGRAPH WITH DECOUPLED INTERRUPTS
// ----------------------------------------------------------------------------
export function createRecoverGraph() {
  const workflow = new StateGraph(RecoverStateAnnotation)
    .addNode("canonicalize_original_state", canonicalizeOriginalState)
    .addNode("check_already_paid", checkAlreadyPaid)
    .addNode("retrieve_knowledge", retrieveKnowledgeNode)
    .addNode("diagnose_failure", diagnoseFailureNode)
    .addNode("propose_recovery", proposeRecoveryNode)
    .addNode("recovery_gate", recoveryGateNode)
    .addNode("mark_awaiting_approval", markAwaitingApprovalNode)
    .addNode("await_approval_interrupt", awaitApprovalInterruptNode)
    .addNode("process_approval_decision", processApprovalDecisionNode)
    .addNode("preflight_revalidate", preflightRevalidateNode)
    .addNode("create_recovery_link", createRecoveryLinkNode)
    .addNode("reconcile_link_creation", reconcileLinkCreationNode)
    .addNode("mark_waiting_recovery_payment", markWaitingRecoveryPaymentNode)
    .addNode("await_recovery_event_interrupt", awaitRecoveryEventInterruptNode)
    .addNode("handle_original_late_capture", handleOriginalLateCaptureNode)
    .addNode("verify_recovery", verifyRecoveryNode);

  // Edges
  workflow.addEdge(START, "canonicalize_original_state");
  workflow.addEdge("canonicalize_original_state", "check_already_paid");

  workflow.addConditionalEdges("check_already_paid", (state) => {
    return state.terminalStatus === "STOPPED_ALREADY_PAID" ? END : "retrieve_knowledge";
  });

  workflow.addEdge("retrieve_knowledge", "diagnose_failure");
  workflow.addEdge("diagnose_failure", "propose_recovery");
  workflow.addEdge("propose_recovery", "recovery_gate");

  workflow.addConditionalEdges("recovery_gate", (state) => {
    if (!state.gate?.authorized) return END;
    return "mark_awaiting_approval";
  });

  workflow.addEdge("mark_awaiting_approval", "await_approval_interrupt");
  workflow.addEdge("await_approval_interrupt", "process_approval_decision");

  workflow.addConditionalEdges("process_approval_decision", (state) => {
    return state.approval?.status === "APPROVED" ? "preflight_revalidate" : END;
  });

  workflow.addConditionalEdges("preflight_revalidate", (state) => {
    return state.terminalStatus === "STOPPED_ALREADY_PAID" ? END : "create_recovery_link";
  });

  workflow.addConditionalEdges("create_recovery_link", (state) => {
    return state.action?.status === "UNCERTAIN"
      ? "reconcile_link_creation"
      : "mark_waiting_recovery_payment";
  });

  workflow.addConditionalEdges("reconcile_link_creation", (state) => {
    return state.terminalStatus === "FAILED_SAFE"
      ? END
      : "mark_waiting_recovery_payment";
  });

  workflow.addEdge("mark_waiting_recovery_payment", "await_recovery_event_interrupt");

  workflow.addConditionalEdges("await_recovery_event_interrupt", (state) => {
    if (state.terminalStatus === "STOPPED_ALREADY_PAID") {
      return "handle_original_late_capture";
    }
    return "verify_recovery";
  });

  workflow.addEdge("handle_original_late_capture", END);
  workflow.addEdge("verify_recovery", END);

  return workflow;
}
