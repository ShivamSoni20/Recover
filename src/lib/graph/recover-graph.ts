import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { RecoverStateAnnotation, type RecoverState } from "./state";
import { fetchRazorpayOrder } from "../razorpay/orders";
import { fetchRazorpayPayment, fetchPaymentsForOrder } from "../razorpay/payments";
import {
  createRecoveryPaymentLink,
  fetchPaymentLink,
  cancelPaymentLink,
} from "../razorpay/payment-links";
import { evaluateRecoveryGate } from "../domain/recovery-gate";
import { getActiveRecoveryPolicy } from "../domain/recovery-policy";
import { getRecoverModel } from "../ai/model";
import { DiagnosisOutputSchema, ProposalOutputSchema } from "../ai/schemas";
import { retrieveRecoveryKnowledge } from "../ai/rag-retriever";
import { supabase } from "../db/supabase";

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
  await supabase.from("recovery_cases").update(updatePayload).eq("id", caseId);
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

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "CANONICAL_PAYMENT_FETCHED",
    label: "Canonical state loaded",
    data: { paymentId: payment.id, status: payment.status, amount: payment.amount },
  });

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
    await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "STOPPED_ALREADY_PAID",
      label: "Transaction already paid - stopping recovery",
    });
    return { terminalStatus: "STOPPED_ALREADY_PAID" };
  }
  return {};
}

// ----------------------------------------------------------------------------
// 3. retrieve_recovery_knowledge
// ----------------------------------------------------------------------------
export async function retrieveKnowledgeNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "RETRIEVING_KNOWLEDGE");
  const payment = state.canonicalPayment;
  const query = `Payment failure reason: ${payment?.errorReason || payment?.errorCode || "unknown"} source: ${payment?.errorSource || "unknown"} step: ${payment?.errorStep || "unknown"} method: ${payment?.method || "unknown"}`;

  const chunks = await retrieveRecoveryKnowledge(query, 3);

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "KNOWLEDGE_RETRIEVED",
    label: "RAG knowledge retrieved",
    data: { chunksCount: chunks.length },
  });

  return { retrievedKnowledge: chunks };
}

// ----------------------------------------------------------------------------
// 4. diagnose_failure
// ----------------------------------------------------------------------------
export async function diagnoseFailureNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "DIAGNOSING");
  const payment = state.canonicalPayment;
  const knowledgeText = state.retrievedKnowledge
    .map((k) => `[Source: ${k.source}] ${k.content}`)
    .join("\n\n");

  const prompt = `You are the AI Financial Failure Diagnostician for Recover.
Analyze the following payment failure strictly using provided provider facts and retrieved knowledge.
DO NOT INVENT AMOUNTS, STATUSES, OR POLICIES.

Provider Failure Facts:
- Payment ID: ${payment?.id}
- Status: ${payment?.status}
- Method: ${payment?.method}
- Error Code: ${payment?.errorCode || "N/A"}
- Error Description: ${payment?.errorDescription || "N/A"}
- Error Source: ${payment?.errorSource || "N/A"}
- Error Step: ${payment?.errorStep || "N/A"}
- Error Reason: ${payment?.errorReason || "N/A"}

Retrieved Knowledge:
${knowledgeText || "Standard Razorpay failure runbook applies."}
`;

  const model = getRecoverModel({ temperature: 0 });
  const structuredModel = model.withStructuredOutput(DiagnosisOutputSchema);
  const diagnosis = await structuredModel.invoke(prompt);

  await supabase.from("recovery_diagnoses").insert({
    case_id: state.caseId,
    failure_class: diagnosis.failureClass,
    confidence: diagnosis.confidence,
    evidence_fields: diagnosis.evidenceFields,
    knowledge_refs: diagnosis.knowledgeRefs,
    summary: diagnosis.summary,
  });

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "FAILURE_DIAGNOSED",
    label: "AI diagnosis completed",
    data: { failureClass: diagnosis.failureClass, confidence: diagnosis.confidence },
  });

  return { diagnosis };
}

// ----------------------------------------------------------------------------
// 5. propose_recovery
// ----------------------------------------------------------------------------
export async function proposeRecoveryNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "RECOVERY_PROPOSED");
  const diagnosis = state.diagnosis;
  const prompt = `Based on the diagnosed failure class '${diagnosis?.failureClass}' and summary '${diagnosis?.summary}', propose the safest recovery strategy.
Allowed strategies: FRESH_CHECKOUT, WAIT_FOR_CANONICAL_UPDATE, MANUAL_REVIEW, STOP_ALREADY_PAID.
DO NOT SPECIFY OR MODIFY FINANCIAL AMOUNTS.`;

  const model = getRecoverModel({ temperature: 0 });
  const structuredModel = model.withStructuredOutput(ProposalOutputSchema);
  const proposal = await structuredModel.invoke(prompt);

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "RECOVERY_PROPOSED",
    label: `Strategy selected: ${proposal.strategy}`,
    data: { strategy: proposal.strategy },
  });

  return {
    proposal: {
      strategy: proposal.strategy,
      explanation: proposal.explanation,
      recommendedDelaySeconds: proposal.recommendedDelaySeconds ?? 0,
    },
  };
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
    existingActiveAction: existingActions?.find((a) => ["CREATING", "CREATED"].includes(a.status)),
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

  const { data: authRecord } = await supabase
    .from("action_authorizations")
    .insert({
      case_id: state.caseId,
      policy_version_id: activePolicy.id,
      strategy: state.proposal?.strategy || "FRESH_CHECKOUT",
      exact_amount_minor: gateResult.exactAmountMinor,
      currency: gateResult.currency,
      canonical_state_hash: `${state.canonicalPayment.id}_${state.canonicalPayment.status}`,
      authorized: gateResult.authorized,
      requires_approval: gateResult.requiresApproval,
      reason_codes: gateResult.reasonCodes,
      gate_checks: gateResult.gateChecks,
    })
    .select("id")
    .single();

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: gateResult.authorized ? "RECOVERY_GATE_AUTHORIZED" : "RECOVERY_GATE_DENIED",
    label: gateResult.authorized ? "Recovery Gate authorized action" : "Recovery Gate denied action",
    data: { authorized: gateResult.authorized, reasonCodes: gateResult.reasonCodes },
  });

  const nextStatus = gateResult.authorized ? "WAITING_APPROVAL" : "MANUAL_REVIEW";
  await updateCaseStatus(state.caseId, nextStatus, gateResult.authorized ? undefined : "MANUAL_REVIEW");

  return {
    policyVersionId: activePolicy.id,
    action: {
      actionId: authRecord?.id,
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
// 7. await_approval (Interrupt for Reviewer)
// ----------------------------------------------------------------------------
export async function awaitApprovalNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "WAITING_APPROVAL");
  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "AWAITING_APPROVAL",
    label: "Awaiting operator approval",
  });

  const decision = interrupt({
    type: "RECOVERY_APPROVAL",
    caseId: state.caseId,
    failureClass: state.diagnosis?.failureClass,
    confidence: state.diagnosis?.confidence,
    strategy: state.proposal?.strategy,
    exactAmountMinor: state.gate?.exactAmountMinor,
    gateChecks: state.gate?.gateChecks,
  }) as { decision: "APPROVE_RECOVERY" | "ESCALATE" | "REJECT" };

  if (decision.decision === "APPROVE_RECOVERY") {
    await updateCaseStatus(state.caseId, "RECOVERY_APPROVED");
    await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "RECOVERY_APPROVED",
      label: "Recovery approved by operator",
    });
    return { approval: { status: "APPROVED", decisionBy: "operator" } };
  } else {
    await updateCaseStatus(state.caseId, "MANUAL_REVIEW", "MANUAL_REVIEW");
    await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "MANUAL_REVIEW",
      label: "Escalated to manual review",
    });
    return {
      approval: { status: "ESCALATED", decisionBy: "operator" },
      terminalStatus: "MANUAL_REVIEW",
    };
  }
}

// ----------------------------------------------------------------------------
// 8. preflight_revalidate
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
    await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "STOPPED_ALREADY_PAID",
      label: "Preflight detected original payment already captured",
    });
    return { terminalStatus: "STOPPED_ALREADY_PAID" };
  }

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "PREFLIGHT_REVALIDATED",
    label: "Preflight recheck passed: still unpaid",
  });

  return {};
}

// ----------------------------------------------------------------------------
// 9. create_recovery_link (With durable intent first)
// ----------------------------------------------------------------------------
export async function createRecoveryLinkNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "CREATING_RECOVERY_LINK");
  const referenceId = state.action?.referenceId || `rcv_${state.caseId.slice(0, 8)}_1`;

  // 1. Create durable intent record before external network call
  const { data: actionRow } = await supabase
    .from("recovery_actions")
    .upsert({
      case_id: state.caseId,
      reference_id: referenceId,
      amount_minor: state.gate!.exactAmountMinor,
      currency: state.gate!.currency,
      status: "CREATING",
    }, { onConflict: "reference_id" })
    .select("id")
    .single();

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

    await supabase
      .from("recovery_actions")
      .update({
        payment_link_id: link.id,
        short_url: link.short_url,
        status: "CREATED",
        updated_at: new Date().toISOString(),
      })
      .eq("reference_id", referenceId);

    await updateCaseStatus(state.caseId, "RECOVERY_LINK_READY");

    await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "PAYMENT_LINK_CREATED",
      label: "Recovery Payment Link created",
      data: { paymentLinkId: link.id, shortUrl: link.short_url, referenceId },
    });

    return {
      action: {
        actionId: actionRow?.id,
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
        actionId: actionRow?.id,
        referenceId,
        status: "UNCERTAIN",
      },
    };
  }
}

// ----------------------------------------------------------------------------
// 10. reconcile_link_creation (Handles uncertainty / network drops)
// ----------------------------------------------------------------------------
export async function reconcileLinkCreationNode(state: RecoverState): Promise<Partial<RecoverState>> {
  const referenceId = state.action?.referenceId;
  if (!referenceId) return { terminalStatus: "FAILED_SAFE" };

  try {
    // Check if recovery link was created using reference query or fallback
    const { data: action } = await supabase
      .from("recovery_actions")
      .select("*")
      .eq("reference_id", referenceId)
      .maybeSingle();

    if (action?.payment_link_id) {
      const link = await fetchPaymentLink(action.payment_link_id);
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

  return { terminalStatus: "FAILED_SAFE" };
}

// ----------------------------------------------------------------------------
// 11. await_recovery_event (Interrupt waiting for webhook)
// ----------------------------------------------------------------------------
export async function awaitRecoveryEventNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "WAITING_RECOVERY_PAYMENT");
  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "WAITING_RECOVERY_PAYMENT",
    label: "Waiting for customer recovery payment",
  });

  const event = interrupt({
    type: "AWAIT_PAYMENT_EVENT",
    caseId: state.caseId,
    paymentLinkId: state.action?.paymentLinkId,
  }) as { eventType: string; paymentId: string };

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
  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "PAYMENT_LINK_CANCELLED_DUE_TO_ORIGINAL_CAPTURE",
    label: "Original payment was captured late; recovery checkout cancelled",
  });

  return { terminalStatus: "STOPPED_ALREADY_PAID" };
}

// ----------------------------------------------------------------------------
// 13. verify_recovery (Canonical Verification against Provider)
// ----------------------------------------------------------------------------
export async function verifyRecoveryNode(state: RecoverState): Promise<Partial<RecoverState>> {
  const action = state.action;
  const paymentId = action?.recoveryPaymentId;
  if (!paymentId) throw new Error("Recovery payment ID missing during verification.");

  await updateCaseStatus(state.caseId, "VERIFYING");
  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "VERIFICATION_STARTED",
    label: "Independent verification running",
  });

  // Re-fetch canonical state independently from Razorpay
  const recoveryPayment = await fetchRazorpayPayment(paymentId);
  const originalPayment = await fetchRazorpayPayment(state.originalPaymentId);
  let linkPaid = true;

  if (action?.paymentLinkId) {
    const link = await fetchPaymentLink(action.paymentLinkId);
    linkPaid = link.status === "paid";
  }

  const checks = [
    {
      key: "recovery_payment_captured",
      expected: true,
      observed: recoveryPayment.captured || recoveryPayment.status === "captured",
      passed: recoveryPayment.captured || recoveryPayment.status === "captured",
    },
    {
      key: "payment_link_paid",
      expected: true,
      observed: linkPaid,
      passed: linkPaid,
    },
    {
      key: "amount_exact",
      expected: state.gate!.exactAmountMinor,
      observed: recoveryPayment.amount,
      passed: recoveryPayment.amount === state.gate!.exactAmountMinor,
    },
    {
      key: "currency_exact",
      expected: state.gate!.currency,
      observed: recoveryPayment.currency,
      passed: recoveryPayment.currency === state.gate!.currency,
    },
    {
      key: "no_double_collection",
      expected: false,
      observed: originalPayment.captured || originalPayment.status === "captured",
      passed: !(originalPayment.captured || originalPayment.status === "captured"),
    },
  ];

  const allPassed = checks.every((c) => c.passed);
  const isDoublePayment = checks.find((c) => c.key === "no_double_collection")?.passed === false;

  const receiptStatus = allPassed
    ? "VERIFIED"
    : isDoublePayment
      ? "DOUBLE_PAYMENT_RISK"
      : "FAILED";

  await supabase.from("verification_receipts").insert({
    case_id: state.caseId,
    original_order_id: state.originalOrderId || "unknown",
    original_payment_id: state.originalPaymentId,
    recovery_link_id: action?.paymentLinkId || "unknown",
    recovery_payment_id: paymentId,
    amount_minor: recoveryPayment.amount,
    currency: recoveryPayment.currency,
    checks_passed: checks,
    status: receiptStatus,
  });

  const terminalStatus = allPassed
    ? "RECOVERED_VERIFIED"
    : isDoublePayment
      ? "DOUBLE_PAYMENT_RISK"
      : "FAILED_SAFE";

  await updateCaseStatus(state.caseId, terminalStatus, terminalStatus);

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: allPassed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED",
    label: allPassed ? "RECOVERED — VERIFIED" : `Verification outcome: ${receiptStatus}`,
    data: { status: receiptStatus, checks },
  });

  return {
    verification: {
      status: receiptStatus,
      checks,
    },
    terminalStatus,
  };
}

// ----------------------------------------------------------------------------
// BUILD THE STATEGRAPH
// ----------------------------------------------------------------------------
export function createRecoverGraph() {
  const workflow = new StateGraph(RecoverStateAnnotation)
    .addNode("canonicalize_original_state", canonicalizeOriginalState)
    .addNode("check_already_paid", checkAlreadyPaid)
    .addNode("retrieve_knowledge", retrieveKnowledgeNode)
    .addNode("diagnose_failure", diagnoseFailureNode)
    .addNode("propose_recovery", proposeRecoveryNode)
    .addNode("recovery_gate", recoveryGateNode)
    .addNode("await_approval", awaitApprovalNode)
    .addNode("preflight_revalidate", preflightRevalidateNode)
    .addNode("create_recovery_link", createRecoveryLinkNode)
    .addNode("reconcile_link_creation", reconcileLinkCreationNode)
    .addNode("await_recovery_event", awaitRecoveryEventNode)
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
    return state.gate?.authorized ? "await_approval" : END;
  });

  workflow.addConditionalEdges("await_approval", (state) => {
    return state.approval?.status === "APPROVED" ? "preflight_revalidate" : END;
  });

  workflow.addConditionalEdges("preflight_revalidate", (state) => {
    return state.terminalStatus === "STOPPED_ALREADY_PAID" ? END : "create_recovery_link";
  });

  workflow.addConditionalEdges("create_recovery_link", (state) => {
    return state.action?.status === "UNCERTAIN"
      ? "reconcile_link_creation"
      : "await_recovery_event";
  });

  workflow.addConditionalEdges("reconcile_link_creation", (state) => {
    return state.terminalStatus === "FAILED_SAFE" ? END : "await_recovery_event";
  });

  workflow.addEdge("await_recovery_event", "verify_recovery");
  workflow.addEdge("verify_recovery", END);

  return workflow;
}
