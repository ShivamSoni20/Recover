import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { RecoverStateAnnotation, type RecoverState } from "./state";
import { fetchRazorpayOrder } from "../razorpay/orders";
import { fetchRazorpayPayment, fetchPaymentsForOrder } from "../razorpay/payments";
import { createRecoveryPaymentLink, cancelPaymentLink } from "../razorpay/payment-links";
import { evaluateRecoveryGate } from "../domain/recovery-gate";
import { getRecoverModel } from "../ai/model";
import { DiagnosisOutputSchema, ProposalOutputSchema } from "../ai/schemas";
import { retrieveRecoveryKnowledge } from "../ai/rag-retriever";
import { supabase } from "../db/supabase";

// ----------------------------------------------------------------------------
// 1. canonicalize_original_state
// ----------------------------------------------------------------------------
export async function canonicalizeOriginalState(state: RecoverState): Promise<Partial<RecoverState>> {
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
  const isOrderPaid = state.canonicalOrder && state.canonicalOrder.amountPaidMinor >= (state.canonicalPayment?.amountMinor || 0);
  const hasSiblingCaptured = state.orderPayments.some((p) => p.id !== state.originalPaymentId && p.captured);

  if (isCaptured || isOrderPaid || hasSiblingCaptured) {
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

  return { proposal };
}

// ----------------------------------------------------------------------------
// 6. recovery_gate
// ----------------------------------------------------------------------------
export async function recoveryGateNode(state: RecoverState): Promise<Partial<RecoverState>> {
  if (!state.canonicalPayment) throw new Error("Canonical payment missing in recovery gate.");

  const gateResult = evaluateRecoveryGate({
    isTestMode: (process.env.RECOVER_RAZORPAY_MODE || "test") === "test",
    canonicalPayment: state.canonicalPayment,
    canonicalOrder: state.canonicalOrder,
    orderPayments: state.orderPayments,
    existingActiveAction: state.action ? { id: state.action.actionId || "", status: state.action.status } : undefined,
    attemptCount: 0,
    failureClass: state.diagnosis?.failureClass || "UNKNOWN",
    confidence: state.diagnosis?.confidence || 0,
    proposedStrategy: state.proposal?.strategy || "MANUAL_REVIEW",
    policy: {
      maxRecoveryAttempts: 2,
      maxAutonomousAmountMinor: 1000000,
      requireApprovalAboveMinor: 0, // Human approval required for all
      allowFreshCheckout: true,
      minDiagnosisConfidence: 0.7,
      blockRiskOrPolicyFailures: true,
      blockUnknownFailures: true,
    },
  });

  await supabase.from("action_authorizations").insert({
    case_id: state.caseId,
    policy_version_id: "00000000-0000-0000-0000-000000000001", // Or mapped ID
    strategy: state.proposal?.strategy || "FRESH_CHECKOUT",
    exact_amount_minor: gateResult.exactAmountMinor,
    currency: gateResult.currency,
    canonical_state_hash: `${state.canonicalPayment.id}_${state.canonicalPayment.status}`,
    authorized: gateResult.authorized,
    requires_approval: gateResult.requiresApproval,
    reason_codes: gateResult.reasonCodes,
    gate_checks: gateResult.gateChecks,
  });

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: gateResult.authorized ? "RECOVERY_GATE_AUTHORIZED" : "RECOVERY_GATE_DENIED",
    label: gateResult.authorized ? "Recovery Gate authorized action" : "Recovery Gate denied action",
    data: { authorized: gateResult.authorized, reasonCodes: gateResult.reasonCodes },
  });

  return {
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
  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "AWAITING_APPROVAL",
    label: "Awaiting operator approval",
  });

  // LangGraph interrupt for human in the loop
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
    await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "RECOVERY_APPROVED",
      label: "Recovery approved by operator",
    });
    return { approval: { status: "APPROVED", decisionBy: "operator" } };
  } else {
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
  const payment = await fetchRazorpayPayment(state.originalPaymentId);
  if (payment.captured || payment.status === "captured") {
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
// 9. create_recovery_link
// ----------------------------------------------------------------------------
export async function createRecoveryLinkNode(state: RecoverState): Promise<Partial<RecoverState>> {
  const shortId = state.caseId.slice(0, 8);
  const referenceId = `rcv_${shortId}_1`;

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

  await supabase.from("recovery_actions").insert({
    case_id: state.caseId,
    reference_id: referenceId,
    payment_link_id: link.id,
    short_url: link.short_url,
    amount_minor: link.amount,
    currency: link.currency,
    status: "CREATED",
  });

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "PAYMENT_LINK_CREATED",
    label: "Recovery Payment Link created",
    data: { paymentLinkId: link.id, shortUrl: link.short_url, referenceId },
  });

  return {
    action: {
      referenceId,
      paymentLinkId: link.id,
      shortUrl: link.short_url,
      status: "CREATED",
    },
  };
}

// ----------------------------------------------------------------------------
// 10. await_recovery_event (Interrupt waiting for webhook)
// ----------------------------------------------------------------------------
export async function awaitRecoveryEventNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "WAITING_RECOVERY_PAYMENT",
    label: "Waiting for customer recovery payment",
  });

  const event = interrupt({
    type: "AWAIT_PAYMENT_EVENT",
    caseId: state.caseId,
    paymentLinkId: state.action?.paymentLinkId,
  }) as { eventType: string; paymentId: string; amountMinor: number };

  return {
    action: {
      ...state.action!,
      status: "PAID",
      recoveryPaymentId: event.paymentId,
    },
  };
}

// ----------------------------------------------------------------------------
// 11. verify_recovery
// ----------------------------------------------------------------------------
export async function verifyRecoveryNode(state: RecoverState): Promise<Partial<RecoverState>> {
  const action = state.action;
  const paymentId = action?.recoveryPaymentId;
  if (!paymentId) throw new Error("Recovery payment ID missing during verification.");

  await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "VERIFICATION_STARTED",
    label: "Independent verification running",
  });

  // Re-fetch canonical state independently
  const recoveryPayment = await fetchRazorpayPayment(paymentId);
  const originalPayment = await fetchRazorpayPayment(state.originalPaymentId);

  const checks = [
    {
      key: "recovery_payment_captured",
      expected: true,
      observed: recoveryPayment.captured || recoveryPayment.status === "captured",
      passed: recoveryPayment.captured || recoveryPayment.status === "captured",
    },
    {
      key: "amount_exact",
      expected: state.gate!.exactAmountMinor,
      observed: recoveryPayment.amount,
      passed: recoveryPayment.amount === state.gate!.exactAmountMinor,
    },
    {
      key: "currency_exact",
      expected: "INR",
      observed: recoveryPayment.currency,
      passed: recoveryPayment.currency === "INR",
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
    terminalStatus: allPassed
      ? "RECOVERED_VERIFIED"
      : isDoublePayment
        ? "DOUBLE_PAYMENT_RISK"
        : "FAILED_SAFE",
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
    .addNode("await_recovery_event", awaitRecoveryEventNode)
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

  workflow.addEdge("create_recovery_link", "await_recovery_event");
  workflow.addEdge("await_recovery_event", "verify_recovery");
  workflow.addEdge("verify_recovery", END);

  return workflow;
}
