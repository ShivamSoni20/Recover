import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { RecoverStateAnnotation, type RecoverState } from "./state";
import { fetchRazorpayPayment, fetchPaymentsForOrder } from "../razorpay/payments";
import { fetchRazorpayOrder } from "../razorpay/orders";
import {
  createRecoveryPaymentLink,
  cancelPaymentLink,
  fetchPaymentLink,
  findPaymentLinkByReferenceId,
} from "../razorpay/payment-links";
import { getRecoverModel } from "../ai/model";
import { DiagnosisOutputSchema, ProposalOutputSchema } from "../ai/schemas";
import {
  evaluateRecoveryGate,
  computeCanonicalStateHash,
  generateCanonicalStateHash,
} from "../domain/recovery-gate";
import { retrieveRecoveryKnowledge } from "../ai/rag-retriever";
import { supabase } from "../db/supabase";
import { requireDbMutation } from "../db/db-utils";
import { getActiveRecoveryPolicy } from "../domain/recovery-policy";

// ----------------------------------------------------------------------------
// DB Helper
// ----------------------------------------------------------------------------
async function updateCaseStatus(
  caseId: string,
  status: string,
  terminalStatus?: string,
): Promise<void> {
  const updateData: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (terminalStatus) {
    updateData.terminal_status = terminalStatus;
  }
  const res = await supabase.from("recovery_cases").update(updateData).eq("id", caseId);
  requireDbMutation(res, `update recovery_cases to status ${status}`);
}

// ----------------------------------------------------------------------------
// 1. canonicalize_original_state
// ----------------------------------------------------------------------------
export async function canonicalizeOriginalState(
  state: RecoverState,
): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "CANONICALIZING");

  // Fetch canonical payment entity from Razorpay
  const payment = await fetchRazorpayPayment(state.originalPaymentId);

  let rawOrder = null;
  let orderPayments: Array<{
    id: string;
    amountMinor: number;
    currency?: string;
    status: string;
    captured: boolean;
  }> = [];

  if (payment.order_id) {
    rawOrder = await fetchRazorpayOrder(payment.order_id);
    const payments = await fetchPaymentsForOrder(payment.order_id);
    orderPayments = payments.map((p) => ({
      id: p.id,
      amountMinor: p.amount,
      currency: p.currency,
      status: p.status,
      captured: p.captured || p.status === "captured",
    }));
  }

  const canonicalPayment = {
    id: payment.id,
    orderId: payment.order_id,
    amountMinor: payment.amount,
    currency: payment.currency,
    status: payment.status,
    method: payment.method || "card",
    errorCode: payment.error_code || "PAYMENT_FAILED",
    errorDescription: payment.error_description || "Payment failed at checkout",
    errorSource: payment.error_source || "bank",
    errorStep: payment.error_step || "payment_authorization",
    errorReason: payment.error_reason || "payment_failed",
    captured: payment.captured || payment.status === "captured",
  };

  const canonicalOrder = rawOrder
    ? {
        id: rawOrder.id,
        amountMinor: rawOrder.amount,
        amountPaidMinor: rawOrder.amount_paid,
        amountDueMinor: rawOrder.amount_due,
        currency: rawOrder.currency,
        status: rawOrder.status,
        attempts: rawOrder.attempts,
      }
    : undefined;

  // Persist canonical metadata to recovery_cases
  const updateRes = await supabase
    .from("recovery_cases")
    .update({
      amount_minor: canonicalPayment.amountMinor,
      currency: canonicalPayment.currency,
      failure_reason: canonicalPayment.errorCode,
      failure_detail: canonicalPayment.errorDescription,
      method: canonicalPayment.method,
      updated_at: new Date().toISOString(),
    })
    .eq("id", state.caseId);
  requireDbMutation(updateRes, "update canonical data in recovery_cases");

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "CANONICAL_PAYMENT_FETCHED",
    label: `Payment ${payment.id} fetched (${payment.status})`,
    data: { payment: canonicalPayment, order: canonicalOrder },
  });
  requireDbMutation(eventRes, "insert CANONICAL_PAYMENT_FETCHED event");

  return {
    canonicalPayment,
    canonicalOrder,
    orderPayments,
    originalOrderId: payment.order_id || state.originalOrderId,
  };
}

// ----------------------------------------------------------------------------
// 2. check_already_paid (Late capture or sibling payment check)
// ----------------------------------------------------------------------------
export async function checkAlreadyPaid(state: RecoverState): Promise<Partial<RecoverState>> {
  const payment = state.canonicalPayment;
  const order = state.canonicalOrder;
  const orderPayments = state.orderPayments || [];

  // Check if original payment itself is captured
  if (payment?.captured || payment?.status === "captured") {
    await updateCaseStatus(state.caseId, "STOPPED_ALREADY_PAID", "STOPPED_ALREADY_PAID");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "STOPPED_ALREADY_PAID",
      label: "Original payment is already captured; recovery stopped",
    });
    requireDbMutation(eventRes, "insert STOPPED_ALREADY_PAID event");
    return { terminalStatus: "STOPPED_ALREADY_PAID" };
  }

  // Check if order is paid by a sibling attempt
  if (order?.status === "paid" || orderPayments.some((p) => p.captured)) {
    await updateCaseStatus(state.caseId, "STOPPED_ALREADY_PAID", "STOPPED_ALREADY_PAID");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "STOPPED_ALREADY_PAID",
      label: "Order has already been paid via another transaction; recovery stopped",
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
  const query =
    `${state.canonicalPayment?.errorCode || ""} ${state.canonicalPayment?.errorDescription || ""} ${state.canonicalPayment?.method || ""}`.trim();

  let chunks: Array<{ chunkId: string; source: string; content: string; score: number }> = [];
  try {
    const rawChunks = await retrieveRecoveryKnowledge(query || "payment failed");
    chunks = rawChunks.map((c) => ({
      chunkId: c.chunkId,
      source: c.source,
      content: c.content,
      score: c.score,
    }));
  } catch (err) {
    console.warn(
      "[RAG Knowledge Notice]: RAG retrieval failed, proceeding with provider facts only:",
      err,
    );
  }

  return {
    retrievedKnowledge: chunks,
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
          .map(
            (k) => `[Source: ${k.source} | Score: ${Math.round(k.score * 100)}%]
${k.content}`,
          )
          .join("\n\n")
      : "NO RETRIEVED KNOWLEDGE AVAILABLE. USE PROVIDER FACTS ONLY.";

  const prompt = `You are an expert autonomous payment recovery diagnosis agent for Razorpay.
Analyze the following payment failure with rigorous precision.

Canonical Provider Payment Data:
- Payment ID: ${state.canonicalPayment?.id}
- Order ID: ${state.canonicalPayment?.orderId || "None"}
- Amount (minor/paise): ${state.canonicalPayment?.amountMinor}
- Currency: ${state.canonicalPayment?.currency}
- Error Code: ${state.canonicalPayment?.errorCode}
- Error Description: ${state.canonicalPayment?.errorDescription}
- Error Source: ${state.canonicalPayment?.errorSource}
- Error Step: ${state.canonicalPayment?.errorStep}
- Error Reason: ${state.canonicalPayment?.errorReason}
- Payment Method: ${state.canonicalPayment?.method}

Policy Knowledge Base:
${knowledgeContext}

Determine:
1. Exact failure class (CUSTOMER_CORRECTABLE, BANK_DECLINE, INSUFFICIENT_FUNDS, AUTHENTICATION_FAILURE, PAYMENT_METHOD_FAILURE, NETWORK_OR_PROCESSING, RISK_OR_POLICY, INVALID_REQUEST, or UNKNOWN).
2. Diagnostic confidence (0.0 to 1.0).
3. Evidence fields.
4. Knowledge refs.
5. Concise summary.
`;

  let diagnosis;
  try {
    diagnosis = await structuredModel.invoke(prompt);
  } catch (err) {
    console.warn(
      "[Diagnosis Fallback]: OpenRouter diagnosis failed, using deterministic safe fallback:",
      err,
    );
    diagnosis = {
      failureClass: "UNKNOWN" as const,
      confidence: 0,
      evidenceFields: [],
      knowledgeRefs: [],
      summary: "Diagnosis unavailable; financial recovery blocked pending manual review.",
    };
  }

  // Persist diagnosis to DB
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
    event_type: "FAILURE_DIAGNOSED",
    label: `Diagnosed: ${diagnosis.failureClass} (${Math.round(diagnosis.confidence * 100)}% conf)`,
    data: diagnosis,
  });
  requireDbMutation(eventRes, "insert FAILURE_DIAGNOSED event");

  return {
    diagnosis: {
      failureClass: diagnosis.failureClass,
      confidence: diagnosis.confidence,
      evidenceFields: diagnosis.evidenceFields,
      knowledgeRefs: diagnosis.knowledgeRefs,
      summary: diagnosis.summary,
    },
  };
}

// ----------------------------------------------------------------------------
// 5. propose_recovery
// ----------------------------------------------------------------------------
export async function proposeRecoveryNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "PROPOSING_RECOVERY");

  const strategy = "FRESH_CHECKOUT" as const;
  const proposal = {
    strategy,
    explanation: "Customer payment failed; create fresh hosted checkout link.",
    recommendedDelaySeconds: 0,
  };

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "RECOVERY_PROPOSED",
    label: `Strategy: ${strategy}`,
    data: proposal,
  });
  requireDbMutation(eventRes, "insert RECOVERY_PROPOSED event");

  return { proposal };
}

// ----------------------------------------------------------------------------
// 6. recovery_gate (Strict deterministic checks)
// ----------------------------------------------------------------------------
export async function recoveryGateNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "EVALUATING_GATE");

  const isTestMode =
    process.env.RECOVER_RAZORPAY_MODE === "test" &&
    Boolean(process.env.RAZORPAY_KEY_ID?.startsWith("rzp_test_"));
  const canonicalPayment = {
    id: state.canonicalPayment?.id || state.originalPaymentId,
    amountMinor: state.canonicalPayment?.amountMinor || 0,
    currency: state.canonicalPayment?.currency || "INR",
    status: state.canonicalPayment?.status || "failed",
    captured: Boolean(state.canonicalPayment?.captured),
    errorCode: state.canonicalPayment?.errorCode,
  };
  const canonicalOrder = state.canonicalOrder;
  const orderPayments = state.orderPayments || [];

  const failureClass = state.diagnosis?.failureClass || "UNKNOWN";
  const confidence = state.diagnosis?.confidence ?? 0;
  const proposedStrategy = state.proposal?.strategy || "FRESH_CHECKOUT";

  let policy;
  try {
    policy = await getActiveRecoveryPolicy();
  } catch (error) {
    await updateCaseStatus(state.caseId, "FAILED_SAFE", "FAILED_SAFE");
    throw new Error("Active recovery policy unavailable; recovery failed closed.", {
      cause: error,
    });
  }
  const { data: attemptedActions, error: attemptsError } = await supabase
    .from("recovery_actions")
    .select("id, status")
    .eq("case_id", state.caseId)
    .in("status", ["CREATING", "CREATED", "UNCERTAIN", "PAID", "CANCELLED", "FAILED"]);
  if (attemptsError)
    throw new Error(`Unable to determine recovery attempt count: ${attemptsError.message}`);
  const attemptCount = attemptedActions?.length || 0;

  const gateOutput = evaluateRecoveryGate({
    isTestMode,
    canonicalPayment,
    canonicalOrder,
    orderPayments,
    existingActiveAction: state.action
      ? { id: state.action.actionId || "", status: state.action.status }
      : undefined,
    attemptCount,
    failureClass,
    confidence,
    proposedStrategy,
    policy,
  });

  const canonicalStateHash = computeCanonicalStateHash({
    paymentId: canonicalPayment.id,
    paymentStatus: canonicalPayment.status,
    paymentCaptured: canonicalPayment.captured,
    paymentAmountMinor: canonicalPayment.amountMinor,
    paymentCurrency: canonicalPayment.currency,
    orderId: canonicalOrder?.id,
    orderStatus: canonicalOrder?.status,
    orderAmountPaidMinor: canonicalOrder?.amountPaidMinor,
    orderAmountDueMinor: canonicalOrder?.amountDueMinor,
    siblingPayments: orderPayments.map((p) => ({
      id: p.id,
      captured: p.captured,
      amountMinor: p.amountMinor,
    })),
    policyVersionId: policy.id,
  });

  const expiresAt = new Date(Date.now() + policy.linkExpiryMinutes * 60 * 1000).toISOString();

  const gateState = {
    authorized: gateOutput.authorized,
    requiresApproval: gateOutput.requiresApproval,
    reasonCodes: gateOutput.reasonCodes,
    gateChecks: gateOutput.gateChecks,
    exactAmountMinor: gateOutput.exactAmountMinor,
    currency: gateOutput.currency,
  };

  // Persist authorization decision
  const authRes = await supabase.from("action_authorizations").insert({
    case_id: state.caseId,
    policy_version_id: policy.id,
    strategy: proposedStrategy,
    exact_amount_minor: gateState.exactAmountMinor,
    currency: gateState.currency,
    canonical_state_hash: canonicalStateHash,
    authorized: gateState.authorized,
    requires_approval: gateState.requiresApproval,
    reason_codes: gateState.reasonCodes,
    gate_checks: gateState.gateChecks,
    expires_at: expiresAt,
  });
  requireDbMutation(authRes, "insert action_authorizations");

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: gateState.authorized ? "GATE_AUTHORIZED" : "GATE_DENIED",
    label: gateState.authorized
      ? `Gate passed (${proposedStrategy})`
      : `Gate denied: ${gateState.reasonCodes.join("; ")}`,
    data: gateState,
  });
  requireDbMutation(eventRes, "insert GATE evaluation event");

  if (!gateState.authorized) {
    const terminalStatus = gateState.reasonCodes.includes("DENY_ALREADY_PAID")
      ? "STOPPED_ALREADY_PAID"
      : "MANUAL_REVIEW";
    await updateCaseStatus(state.caseId, terminalStatus, terminalStatus);
    return {
      gate: gateState,
      terminalStatus,
    };
  }

  return { gate: gateState, policyVersionId: policy.id };
}

// ----------------------------------------------------------------------------
// 7A. mark_awaiting_approval (Side effects before interrupt)
// ----------------------------------------------------------------------------
export async function markAwaitingApprovalNode(
  state: RecoverState,
): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "WAITING_APPROVAL");
  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "AWAITING_APPROVAL",
    label: "Awaiting human-in-the-loop merchant approval",
  });
  requireDbMutation(eventRes, "insert AWAITING_APPROVAL event");
  return {};
}

// ----------------------------------------------------------------------------
// 7B. await_approval_interrupt (Pure interrupt node)
// ----------------------------------------------------------------------------
export async function awaitApprovalInterruptNode(
  state: RecoverState,
): Promise<Partial<RecoverState>> {
  const decision = interrupt({
    type: "APPROVAL_REQUEST",
    caseId: state.caseId,
    strategy: state.proposal?.strategy,
    amountMinor: state.gate?.exactAmountMinor,
    currency: state.gate?.currency,
  }) as {
    decision: "APPROVE_RECOVERY" | "ESCALATE" | "REJECT";
    decidedBy?: string;
    note?: string;
  };

  const status =
    decision.decision === "APPROVE_RECOVERY"
      ? "APPROVED"
      : decision.decision === "ESCALATE"
        ? "ESCALATED"
        : "REJECTED";

  return {
    approval: {
      status,
      decisionBy: decision.decidedBy || "merchant_operator",
    },
  };
}

// ----------------------------------------------------------------------------
// 7C. process_approval_decision (Side effects after resume)
// ----------------------------------------------------------------------------
export async function processApprovalDecisionNode(
  state: RecoverState,
): Promise<Partial<RecoverState>> {
  const approval = state.approval;
  if (!approval) return {};

  const decRes = await supabase.from("recovery_decisions").insert({
    case_id: state.caseId,
    decision: approval.status,
    actor: approval.decisionBy || "merchant_operator",
  });
  requireDbMutation(decRes, "insert recovery_decisions");

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: `APPROVAL_${approval.status}`,
    label: `Merchant decision: ${approval.status}`,
    data: approval,
  });
  requireDbMutation(eventRes, "insert recovery decision event");

  if (approval.status !== "APPROVED") {
    const terminalStatus = approval.status === "ESCALATED" ? "MANUAL_REVIEW" : "FAILED_SAFE";
    await updateCaseStatus(state.caseId, terminalStatus, terminalStatus);
    return { terminalStatus };
  }

  return {};
}

// ----------------------------------------------------------------------------
// 8. preflight_revalidate (Pre-action canonical check, expiry & active mutex)
// ----------------------------------------------------------------------------
export async function preflightRevalidateNode(state: RecoverState): Promise<Partial<RecoverState>> {
  await updateCaseStatus(state.caseId, "PREFLIGHT_CHECK");

  // 1. P0-8: Enforce Authorization Expiry
  const { data: authRecord } = await supabase
    .from("action_authorizations")
    .select("*")
    .eq("case_id", state.caseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (authRecord?.expires_at && new Date(authRecord.expires_at) <= new Date()) {
    console.warn(`[Preflight] Authorization expired for case ${state.caseId}`);
    await updateCaseStatus(state.caseId, "MANUAL_REVIEW", "MANUAL_REVIEW");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "AUTHORIZATION_EXPIRED",
      label: "Preflight detected expired authorization; routed to manual review",
    });
    requireDbMutation(eventRes, "insert AUTHORIZATION_EXPIRED event");
    return { terminalStatus: "MANUAL_REVIEW" };
  }

  // 2. Re-fetch canonical state from Razorpay
  const payment = await fetchRazorpayPayment(state.originalPaymentId);
  let orderPaid = false;
  let rawOrder = null;
  let payments: any[] = [];

  if (payment.order_id) {
    rawOrder = await fetchRazorpayOrder(payment.order_id);
    payments = await fetchPaymentsForOrder(payment.order_id);
    orderPaid =
      rawOrder.status === "paid" || payments.some((p) => p.captured || p.status === "captured");
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

  // 3. P0-9: Enforce canonical_state_hash
  const currentHash = computeCanonicalStateHash({
    paymentId: payment.id,
    paymentStatus: payment.status,
    paymentCaptured: Boolean(payment.captured || payment.status === "captured"),
    paymentAmountMinor: payment.amount,
    paymentCurrency: payment.currency,
    orderId: rawOrder?.id,
    orderStatus: rawOrder?.status,
    orderAmountPaidMinor: rawOrder?.amount_paid,
    orderAmountDueMinor: rawOrder?.amount_due,
    siblingPayments: payments.map((p) => ({
      id: p.id,
      captured: Boolean(p.captured || p.status === "captured"),
      amountMinor: p.amount,
    })),
    policyVersionId: authRecord?.policy_version_id,
  });
  if (authRecord?.canonical_state_hash && authRecord.canonical_state_hash !== currentHash) {
    console.warn(
      `[Preflight] State hash mismatch for case ${state.caseId}: auth=${authRecord.canonical_state_hash} curr=${currentHash}`,
    );
    await updateCaseStatus(state.caseId, "MANUAL_REVIEW", "MANUAL_REVIEW");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "CANONICAL_HASH_CHANGED",
      label: "Preflight detected provider state change since authorization",
      data: { authHash: authRecord.canonical_state_hash, currentHash },
    });
    requireDbMutation(eventRes, "insert CANONICAL_HASH_CHANGED event");
    return { terminalStatus: "MANUAL_REVIEW" };
  }

  // 4. P0-10: Preflight must recheck existing active / uncertain actions
  const { data: existingActions, error: existingActionsError } = await supabase
    .from("recovery_actions")
    .select("id, status, payment_link_id, short_url, reference_id, recovery_payment_id")
    .eq("case_id", state.caseId)
    .in("status", ["CREATING", "CREATED", "UNCERTAIN", "PAID"]);
  if (existingActionsError)
    throw new Error(`Unable to inspect existing recovery actions: ${existingActionsError.message}`);

  if (existingActions && existingActions.length > 0) {
    const activeAction = existingActions[0];
    if (activeAction) {
      const safeStatus =
        activeAction.status === "CREATED" && !activeAction.payment_link_id
          ? "UNCERTAIN"
          : activeAction.status;
      console.log(
        `[Preflight] Found existing active action ${activeAction.id} for case ${state.caseId}`,
      );
      return {
        action: {
          actionId: activeAction.id,
          referenceId: activeAction.reference_id,
          paymentLinkId: activeAction.payment_link_id,
          shortUrl: activeAction.short_url,
          status: safeStatus,
          recoveryPaymentId: activeAction.recovery_payment_id || undefined,
        },
      };
    }
  }

  const eventRes = await supabase.from("case_events").insert({
    case_id: state.caseId,
    event_type: "PREFLIGHT_REVALIDATED",
    label: "Preflight recheck passed: still unpaid, hash valid",
  });
  requireDbMutation(eventRes, "insert PREFLIGHT_REVALIDATED event");

  return {};
}

// ----------------------------------------------------------------------------
// 9. create_recovery_link (With durable intent first)
// ----------------------------------------------------------------------------
export async function createRecoveryLinkNode(state: RecoverState): Promise<Partial<RecoverState>> {
  if (state.action && ["CREATING", "CREATED", "UNCERTAIN", "PAID"].includes(state.action.status)) {
    return {};
  }

  await updateCaseStatus(state.caseId, "CREATING_RECOVERY_LINK");
  const referenceId = state.action?.referenceId || `rcv_${state.caseId.slice(0, 8)}_1`;

  // 1. Create durable intent record before external network call
  const { data: actionRow, error: actionError } = await supabase
    .from("recovery_actions")
    .insert({
      case_id: state.caseId,
      reference_id: referenceId,
      amount_minor: state.gate!.exactAmountMinor,
      currency: state.gate!.currency,
      status: "CREATING",
    })
    .select("id")
    .single();

  if (actionError?.code === "23505") {
    const { data: existing, error: existingError } = await supabase
      .from("recovery_actions")
      .select("id, reference_id, payment_link_id, short_url, status, recovery_payment_id")
      .eq("case_id", state.caseId)
      .in("status", ["CREATING", "CREATED", "UNCERTAIN", "PAID"])
      .limit(1)
      .maybeSingle();
    if (existingError || !existing) {
      throw new Error(`Concurrent recovery action could not be adopted: ${existingError?.message}`);
    }
    return {
      action: {
        actionId: existing.id,
        referenceId: existing.reference_id,
        paymentLinkId: existing.payment_link_id || undefined,
        shortUrl: existing.short_url || undefined,
        status: existing.status,
        recoveryPaymentId: existing.recovery_payment_id || undefined,
      },
    };
  }

  if (actionError || !actionRow) {
    throw new Error(`Failed to persist recovery action intent: ${actionError?.message}`);
  }

  try {
    // 2. Call Razorpay API to create Payment Link
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
    const uncertainUpdate = await supabase
      .from("recovery_actions")
      .update({ status: "UNCERTAIN", updated_at: new Date().toISOString() })
      .eq("reference_id", referenceId);
    requireDbMutation(uncertainUpdate, "update recovery action to UNCERTAIN");

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
export async function reconcileLinkCreationNode(
  state: RecoverState,
): Promise<Partial<RecoverState>> {
  const referenceId = state.action?.referenceId;
  if (!referenceId) return { terminalStatus: "FAILED_SAFE" };

  try {
    const searchResult = await findPaymentLinkByReferenceId(referenceId);
    if (searchResult.status === "FOUND") {
      const link = searchResult.link;
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

      return {
        action: {
          actionId: state.action?.actionId,
          referenceId,
          paymentLinkId: link.id,
          shortUrl: link.short_url,
          status: "CREATED",
        },
      };
    } else if (searchResult.status === "NOT_FOUND") {
      await updateCaseStatus(state.caseId, "FAILED_SAFE", "FAILED_SAFE");
      return {
        action: {
          actionId: state.action?.actionId,
          referenceId,
          status: "UNCERTAIN",
        },
        terminalStatus: "FAILED_SAFE",
      };
    } else {
      console.warn(
        "[Reconcile Link Notice]: Provider unavailable during reference search",
        searchResult,
      );
      return {
        action: {
          actionId: state.action?.actionId,
          referenceId,
          status: "UNCERTAIN",
        },
        terminalStatus: "FAILED_SAFE",
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
export async function markWaitingRecoveryPaymentNode(
  state: RecoverState,
): Promise<Partial<RecoverState>> {
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
export async function awaitRecoveryEventInterruptNode(
  state: RecoverState,
): Promise<Partial<RecoverState>> {
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
// 12. handle_original_late_capture (P0-11: Cancels link safely, checks double payment)
// ----------------------------------------------------------------------------
export async function handleOriginalLateCaptureNode(
  state: RecoverState,
): Promise<Partial<RecoverState>> {
  const paymentLinkId = state.action?.paymentLinkId;

  if (!paymentLinkId) {
    await updateCaseStatus(state.caseId, "FAILED_SAFE", "FAILED_SAFE");
    return { terminalStatus: "FAILED_SAFE" };
  }

  let linkAfter;
  try {
    const linkBefore = await fetchPaymentLink(paymentLinkId);
    if (linkBefore.status === "created") await cancelPaymentLink(paymentLinkId);
    linkAfter = await fetchPaymentLink(paymentLinkId);
  } catch (providerError) {
    console.warn(`[Late Capture] Provider truth unavailable for ${paymentLinkId}:`, providerError);
    await updateCaseStatus(state.caseId, "FAILED_SAFE", "FAILED_SAFE");
    return { terminalStatus: "FAILED_SAFE" };
  }

  const originalPayment = await fetchRazorpayPayment(state.originalPaymentId);
  const linkedPaymentId = state.action?.recoveryPaymentId || linkAfter.payments?.[0]?.payment_id;
  const recoveryPayment = linkedPaymentId ? await fetchRazorpayPayment(linkedPaymentId) : null;

  const isDoublePayment =
    (originalPayment.captured || originalPayment.status === "captured") &&
    recoveryPayment &&
    (recoveryPayment.captured || recoveryPayment.status === "captured");

  if (isDoublePayment || linkAfter.status === "paid") {
    await updateCaseStatus(state.caseId, "DOUBLE_PAYMENT_RISK", "DOUBLE_PAYMENT_RISK");
    const eventRes = await supabase.from("case_events").insert({
      case_id: state.caseId,
      event_type: "DOUBLE_PAYMENT_RISK",
      label: "Original and recovery payments both captured; flagged double payment risk",
    });
    requireDbMutation(eventRes, "insert DOUBLE_PAYMENT_RISK event");
    return { terminalStatus: "DOUBLE_PAYMENT_RISK" };
  }

  if (linkAfter.status !== "cancelled") {
    await updateCaseStatus(state.caseId, "FAILED_SAFE", "FAILED_SAFE");
    return { terminalStatus: "FAILED_SAFE" };
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
// 13. verify_recovery (P0-1 & P0-15 & P0-16: Strict independent verification & receipts)
// ----------------------------------------------------------------------------
export async function verifyRecoveryNode(state: RecoverState): Promise<Partial<RecoverState>> {
  // P0-16: Idempotency & Immutability: Check existing receipt BEFORE updating status or re-fetching
  const { data: existingReceipt } = await supabase
    .from("verification_receipts")
    .select("*")
    .eq("case_id", state.caseId)
    .maybeSingle();

  if (existingReceipt) {
    if (existingReceipt.status === "VERIFIED") {
      return {
        verification: {
          status: "VERIFIED",
          receiptId: existingReceipt.id,
          checks: existingReceipt.checks_passed as any,
        },
        terminalStatus: "RECOVERED_VERIFIED",
      };
    }
    if (existingReceipt.status === "DOUBLE_PAYMENT_RISK") {
      return {
        verification: {
          status: "DOUBLE_PAYMENT_RISK",
          receiptId: existingReceipt.id,
          checks: existingReceipt.checks_passed as any,
        },
        terminalStatus: "DOUBLE_PAYMENT_RISK",
      };
    }
  }

  await updateCaseStatus(state.caseId, "VERIFYING_RECOVERY");

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

  let originalOrderPayments: Array<{
    id: string;
    status: string;
    captured: boolean;
    amount: number;
  }> = [];
  if (originalPayment.order_id) {
    originalOrderPayments = await fetchPaymentsForOrder(originalPayment.order_id);
  }

  // P0-15: Strict relationship check between recovery payment and payment link
  const linkHasPayment =
    recoveryPayment.notes?.payment_link_id === paymentLinkId ||
    (Array.isArray(paymentLink.payments) &&
      paymentLink.payments.length > 0 &&
      paymentLink.payments.some(
        (p: any) => p.payment_id === recoveryPayment.id || p.id === recoveryPayment.id,
      )) ||
    (!Array.isArray(paymentLink.payments) &&
      paymentLink.status === "paid" &&
      (!recoveryPayment.notes?.payment_link_id ||
        recoveryPayment.notes?.payment_link_id === paymentLinkId));

  // 2. Perform strictly deterministic verification checks
  const checks = [
    {
      key: "RECOVERY_PAYMENT_CAPTURED",
      expected: true,
      observed: recoveryPayment.captured || recoveryPayment.status === "captured",
      passed: Boolean(recoveryPayment.captured || recoveryPayment.status === "captured"),
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
      key: "RECOVERY_PAYMENT_LINK_RELATIONSHIP",
      expected: paymentLinkId,
      observed: linkHasPayment ? paymentLinkId : "UNLINKED",
      passed: Boolean(linkHasPayment),
    },
    {
      key: "REFERENCE_ID_MATCH",
      expected: state.action?.referenceId,
      observed: paymentLink.reference_id,
      passed: Boolean(
        paymentLink.reference_id && paymentLink.reference_id === state.action?.referenceId,
      ),
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
      observed: originalOrderPayments.filter(
        (p) => p.id !== recoveryPayment.id && (p.captured || p.status === "captured"),
      ).length,
      passed: !originalOrderPayments.some(
        (p) => p.id !== recoveryPayment.id && (p.captured || p.status === "captured"),
      ),
    },
  ];

  const allPassed = checks.every((c) => c.passed);
  const isDoublePayment =
    (originalPayment.captured || originalPayment.status === "captured") &&
    (recoveryPayment.captured || recoveryPayment.status === "captured");

  const receiptStatus = allPassed ? "VERIFIED" : isDoublePayment ? "DOUBLE_PAYMENT_RISK" : "FAILED";

  // P0-1: Full schema alignment write for verification_receipts
  const receiptUpsert = await supabase.from("verification_receipts").upsert(
    {
      case_id: state.caseId,
      action_id: state.action?.actionId || null,
      original_order_id: state.originalOrderId || originalPayment.order_id || "unknown",
      original_payment_id: state.originalPaymentId,
      recovery_link_id: paymentLinkId,
      recovery_payment_id: recoveryPayment.id,
      amount_minor: recoveryPayment.amount,
      currency: recoveryPayment.currency,
      checks_passed: checks,
      status: receiptStatus,
      verified_at: new Date().toISOString(),
    },
    { onConflict: "case_id" },
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
    return state.terminalStatus === "STOPPED_ALREADY_PAID" ||
      state.terminalStatus === "MANUAL_REVIEW"
      ? END
      : state.action?.status === "PAID"
        ? "verify_recovery"
        : "create_recovery_link";
  });

  workflow.addConditionalEdges("create_recovery_link", (state) => {
    if (state.action?.status === "PAID") return "verify_recovery";
    return state.action?.status === "UNCERTAIN" || state.action?.status === "CREATING"
      ? "reconcile_link_creation"
      : "mark_waiting_recovery_payment";
  });

  workflow.addConditionalEdges("reconcile_link_creation", (state) => {
    return state.terminalStatus === "FAILED_SAFE" ? END : "mark_waiting_recovery_payment";
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
