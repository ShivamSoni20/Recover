import { Command } from "@langchain/langgraph";
import { createRecoverGraph } from "./recover-graph";
import { getCheckpointer } from "./checkpointer";
import type { RecoverState } from "./state";
import { supabase } from "../db/supabase";
import { requireDbMutation } from "../db/db-utils";

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

export interface RecoverySuccessClaim {
  claimed: boolean;
  isOwner: boolean;
  actionId: string;
  caseId: string;
  acceptedEventId: string;
  workflowAppliedAt: string | null;
  recoveryPaymentId: string | null;
}

export async function claimRecoverySuccessEvent(params: {
  actionId: string;
  providerEventId: string;
  paymentId: string;
}): Promise<RecoverySuccessClaim> {
  const { data, error } = await supabase.rpc("claim_recovery_success_event", {
    p_action_id: params.actionId,
    p_provider_event_id: params.providerEventId,
    p_payment_id: params.paymentId,
  });
  if (error) throw new Error(`[Runner] Atomic success-event claim failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as {
    claimed: boolean;
    is_owner: boolean;
    action_id: string;
    case_id: string;
    accepted_event_id: string;
    workflow_applied_at: string | null;
    recovery_payment_id: string | null;
  } | null;
  if (!row) throw new Error("[Runner] Atomic success-event claim returned no recovery action.");
  return {
    claimed: row.claimed,
    isOwner: row.is_owner,
    actionId: row.action_id,
    caseId: row.case_id,
    acceptedEventId: row.accepted_event_id,
    workflowAppliedAt: row.workflow_applied_at,
    recoveryPaymentId: row.recovery_payment_id,
  };
}

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
      throw new Error(`[LangGraph Runner] Durable state inspection failed for ${params.caseId}.`, {
        cause: stateErr,
      });
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
  actionId: string;
  caseId: string;
  paymentLinkId?: string;
  paymentId: string;
  providerEventId?: string;
  amountMinor?: number;
  eventType?: string;
}): Promise<void> {
  if (!params.providerEventId)
    throw new Error("Provider event ID is required for recovery resume.");

  const { data: actionRow, error: actionError } = await supabase
    .from("recovery_actions")
    .select("accepted_success_event_id, workflow_event_applied_at, recovery_payment_id")
    .eq("id", params.actionId)
    .eq("case_id", params.caseId)
    .maybeSingle();
  if (actionError)
    throw new Error(`[Runner] Failed to read recovery action: ${actionError.message}`);
  if (!actionRow) throw new Error("[Runner] Accepted recovery action no longer exists.");
  if (actionRow.accepted_success_event_id !== params.providerEventId) return;
  if (actionRow.workflow_event_applied_at) return;

  // Check case terminal status from DB
  const { data: caseRow, error: caseError } = await supabase
    .from("recovery_cases")
    .select("status, terminal_status")
    .eq("id", params.caseId)
    .maybeSingle();
  if (caseError) throw new Error(`[Runner] Failed to read recovery case: ${caseError.message}`);

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

  const checkpointer = await getCheckpointer();
  const graph = createRecoverGraph().compile({ checkpointer });
  const config = { configurable: { thread_id: params.caseId } };
  const durableState = await graph.getState(config);
  const durableValues = durableState.values as Partial<RecoverState>;
  const alreadyAdvanced =
    durableValues.action?.recoveryPaymentId === params.paymentId ||
    Boolean(durableValues.terminalStatus);

  if (!alreadyAdvanced) {
    await graph.invoke(
      new Command({
        resume: {
          kind: "RECOVERY_PAYMENT_CAPTURED",
          eventType: params.eventType || "payment.captured",
          paymentId: params.paymentId,
          paymentLinkId: params.paymentLinkId,
          amountMinor: params.amountMinor,
          providerEventId: params.providerEventId,
        },
      }),
      config,
    );
  }

  // Mark workflow event applied on recovery_actions
  const appliedUpdate = await supabase
    .from("recovery_actions")
    .update({
      workflow_event_applied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.actionId)
    .eq("accepted_success_event_id", params.providerEventId)
    .is("workflow_event_applied_at", null);
  requireDbMutation(appliedUpdate, "mark recovery workflow event applied");
}
