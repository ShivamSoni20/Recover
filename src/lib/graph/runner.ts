import { Command } from "@langchain/langgraph";
import { createRecoverGraph } from "./recover-graph";
import { getCheckpointer } from "./checkpointer";
import type { RecoverState } from "./state";

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

export async function resumeWorkflowWithDecision(
  caseId: string,
  decision: "APPROVE_RECOVERY" | "ESCALATE" | "REJECT"
): Promise<void> {
  const checkpointer = await getCheckpointer();
  const graph = createRecoverGraph().compile({ checkpointer });

  const config = { configurable: { thread_id: caseId } };
  await graph.invoke(new Command({ resume: { decision } }), config);
}

export async function resumeWorkflowWithPaymentEvent(
  caseId: string,
  event: { eventType: string; paymentId: string; amountMinor: number }
): Promise<void> {
  const checkpointer = await getCheckpointer();
  const graph = createRecoverGraph().compile({ checkpointer });

  const config = { configurable: { thread_id: caseId } };
  await graph.invoke(new Command({ resume: event }), config);
}
