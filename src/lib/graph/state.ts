import { Annotation } from "@langchain/langgraph";
import type { FailureClass, RecoveryStrategy } from "../ai/schemas";
import type { GateCheckResult, GateReasonCode } from "../domain/recovery-gate";

export interface CanonicalOrder {
  id: string;
  amountMinor: number;
  amountPaidMinor: number;
  amountDueMinor: number;
  currency: string;
  status: string;
  attempts: number;
}

export interface CanonicalPayment {
  id: string;
  orderId: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  captured: boolean;
  method?: string;
  errorCode?: string | null;
  errorDescription?: string | null;
  errorSource?: string | null;
  errorStep?: string | null;
  errorReason?: string | null;
}

export interface OrderPayment {
  id: string;
  status: string;
  captured: boolean;
  amountMinor: number;
}

export interface RetrievedKnowledge {
  chunkId: string;
  source: string;
  content: string;
  score: number;
}

export interface DiagnosisState {
  failureClass: FailureClass;
  confidence: number;
  evidenceFields: string[];
  knowledgeRefs: string[];
  summary: string;
}

export interface ProposalState {
  strategy: RecoveryStrategy;
  explanation: string;
  recommendedDelaySeconds: number;
}

export interface GateState {
  authorized: boolean;
  requiresApproval: boolean;
  reasonCodes: GateReasonCode[];
  gateChecks: GateCheckResult[];
  exactAmountMinor: number;
  currency: string;
}

export interface ApprovalState {
  status: "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED" | "ESCALATED";
  decisionBy?: string;
}

export interface ActionState {
  actionId?: string;
  referenceId: string;
  paymentLinkId?: string;
  shortUrl?: string;
  status: "NOT_STARTED" | "CREATING" | "CREATED" | "UNCERTAIN" | "CANCELLED" | "FAILED" | "PAID";
  recoveryPaymentId?: string;
}

export interface VerificationCheckItem {
  key: string;
  expected: unknown;
  observed: unknown;
  passed: boolean;
}

export interface VerificationState {
  status: "PENDING" | "VERIFIED" | "FAILED" | "DOUBLE_PAYMENT_RISK";
  receiptId?: string;
  checks: VerificationCheckItem[];
}

export type TerminalStatus =
  | "RECOVERED_VERIFIED"
  | "STOPPED_ALREADY_PAID"
  | "MANUAL_REVIEW"
  | "DOUBLE_PAYMENT_RISK"
  | "FAILED_SAFE";

export const RecoverStateAnnotation = Annotation.Root({
  caseId: Annotation<string>(),
  threadId: Annotation<string>(),
  originalOrderId: Annotation<string>(),
  originalPaymentId: Annotation<string>(),

  canonicalOrder: Annotation<CanonicalOrder | undefined>(),
  canonicalPayment: Annotation<CanonicalPayment | undefined>(),
  orderPayments: Annotation<OrderPayment[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  policyVersionId: Annotation<string | undefined>(),
  retrievedKnowledge: Annotation<RetrievedKnowledge[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  diagnosis: Annotation<DiagnosisState | undefined>(),
  proposal: Annotation<ProposalState | undefined>(),
  gate: Annotation<GateState | undefined>(),
  approval: Annotation<ApprovalState | undefined>(),
  action: Annotation<ActionState | undefined>(),
  verification: Annotation<VerificationState | undefined>(),
  terminalStatus: Annotation<TerminalStatus | undefined>(),
});

export type RecoverState = typeof RecoverStateAnnotation.State;
