import { Command } from "@langchain/langgraph";
import { createRecoverGraph } from "./recover-graph";
import { getCheckpointer } from "./checkpointer";
import type { RecoverState } from "./state";

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
    console.log(
      `[LangGraph Runner] Workflow already has durable checkpoint for thread ${params.caseId}. Skipping initial invoke.`,
    );
    return;
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
