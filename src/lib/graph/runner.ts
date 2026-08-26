import { Command } from "@langchain/langgraph";
import { createRecoverGraph } from "./recover-graph";
import { getCheckpointer } from "./checkpointer";
import type { RecoverState } from "./state";
import { supabase } from "../db/supabase";

export type RecoveryResumeEvent =
  | {
      kind: "RECOVERY_PAYMENT_CAPTURED";
      eventType: string;
      paymentId: string;
      paymentLinkId?: string;
      amountMinor?: number;
      providerEventId?: string;
    }
  | {
      kind: "ORIGINAL_PAYMENT_CAPTURED";
      eventType: string;
      paymentId: string;
      providerEventId?: string;
    };

export async function startRecoveryWorkflow(params: {
  caseId: string;
  originalOrderId: string;
  originalPaymentId: string;
}): Promise<void> {
  const checkpointer = await getCheckpointer();
  const graph = createRecoverGraph().compile({ checkpointer });

  const initialInput: Partial<RecoverState> = {
    caseId: params.caseId,
    threadId: params.caseId,
    originalOrderId: params.originalOrderId,
    originalPaymentId: params.originalPaymentId,
  };

  const config = { configurable: { thread_id: params.caseId } };
  await graph.invoke(initialInput, config);
}

export async function ensureRecoveryWorkflowStarted(params: {
  caseId: string;
  originalOrderId: string;
  originalPaymentId: string;
}): Promise<void> {
  const checkpointer = await getCheckpointer();
  const config = { configurable: { thread_id: params.caseId } };

  // Check if thread already has a durable checkpoint
  const existingTuple = await checkpointer.getTuple(config);
  if (existingTuple && existingTuple.checkpoint) {
    const graph = createRecoverGraph().compile({ checkpointer });
    try {
      const state = await graph.getState(config);
      // If graph is at an interrupt (WAITING_APPROVAL or WAITING_RECOVERY_PAYMENT) or finished, do not re-invoke
      if (
        (state.next && state.next.length === 0) ||
        state.tasks?.some((t) => t.interrupts && t.interrupts.length > 0)
      ) {
        console.log(
          `[LangGraph Runner] Workflow is at valid interrupt or terminal state for thread ${params.caseId}. Skipping initial invoke.`,
        );
        return;
      }
      // If graph halted mid-stream due to transient failure, progress safely on the thread
      console.log(
        `[LangGraph Runner] Progressing interrupted workflow from checkpoint on thread ${params.caseId}...`,
      );
      await graph.invoke(null, config);
      return;
    } catch (stateErr) {
      console.warn(`[LangGraph Runner] State inspection notice for ${params.caseId}:`, stateErr);
      return;
    }
  }

  await startRecoveryWorkflow(params);
}

export async function resumeWorkflowWithDecision(
  caseId: string,
  decision: "APPROVE_RECOVERY" | "ESCALATE" | "REJECT",
): Promise<void> {
  const checkpointer = await getCheckpointer();
  const graph = createRecoverGraph().compile({ checkpointer });

  const config = { configurable: { thread_id: caseId } };
  await graph.invoke(new Command({ resume: { decision } }), config);
}

export async function resumeWorkflowWithPaymentEvent(
  caseId: string,
  event: RecoveryResumeEvent,
): Promise<void> {
  const checkpointer = await getCheckpointer();
  const graph = createRecoverGraph().compile({ checkpointer });

  const config = { configurable: { thread_id: caseId } };
  await graph.invoke(new Command({ resume: event }), config);
}

export async function ensureRecoveryPaymentEventApplied(params: {
  caseId: string;
  paymentLinkId?: string;
  paymentId: string;
  providerEventId?: string;
  amountMinor?: number;
  eventType?: string;
}): Promise<void> {
  // Check case terminal status from DB
  const { data: caseRow } = await supabase
    .from("recovery_cases")
    .select("status, terminal_status")
    .eq("id", params.caseId)
    .maybeSingle();

  if (
    caseRow &&
    ["RECOVERED_VERIFIED", "STOPPED_ALREADY_PAID", "DOUBLE_PAYMENT_RISK", "FAILED_SAFE"].includes(
      caseRow.terminal_status || "",
    )
  ) {
    console.log(
      `[Runner] Case ${params.caseId} already in terminal status ${caseRow.terminal_status}; skipping resume.`,
    );
    return;
  }

  const { data: actionRow } = await supabase
    .from("recovery_actions")
    .select("workflow_event_applied_at")
    .eq("case_id", params.caseId)
    .maybeSingle();

  if (actionRow?.workflow_event_applied_at) {
    console.log(
      `[Runner] Recovery event already durably applied for case ${params.caseId}; skipping.`,
    );
    return;
  }

  // Resume LangGraph workflow on the thread
  await resumeWorkflowWithPaymentEvent(params.caseId, {
    kind: "RECOVERY_PAYMENT_CAPTURED",
    eventType: params.eventType || "payment.captured",
    paymentId: params.paymentId,
    paymentLinkId: params.paymentLinkId,
    amountMinor: params.amountMinor,
    providerEventId: params.providerEventId,
  });

  // Mark workflow event applied on recovery_actions
  await supabase
    .from("recovery_actions")
    .update({
      workflow_event_applied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("case_id", params.caseId);
}
