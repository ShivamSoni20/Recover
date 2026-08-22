import { z } from "zod";

export const FailureClassSchema = z.enum([
  "CUSTOMER_CORRECTABLE",
  "BANK_DECLINE",
  "INSUFFICIENT_FUNDS",
  "AUTHENTICATION_FAILURE",
  "PAYMENT_METHOD_FAILURE",
  "NETWORK_OR_PROCESSING",
  "RISK_OR_POLICY",
  "INVALID_REQUEST",
  "UNKNOWN",
]);

export type FailureClass = z.infer<typeof FailureClassSchema>;

export const RecoveryStrategySchema = z.enum([
  "FRESH_CHECKOUT",
  "WAIT_FOR_CANONICAL_UPDATE",
  "MANUAL_REVIEW",
  "STOP_ALREADY_PAID",
]);

export type RecoveryStrategy = z.infer<typeof RecoveryStrategySchema>;

export const DiagnosisOutputSchema = z.object({
  failureClass: FailureClassSchema,
  confidence: z.number().min(0).max(1),
  evidenceFields: z.array(z.string()).describe("Field names or extracted values used as evidence"),
  knowledgeRefs: z.array(z.string()).describe("Knowledge base references supporting the diagnosis"),
  summary: z.string().describe("Concise explanation of why the payment failed"),
});

export type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;

export const ProposalOutputSchema = z.object({
  strategy: RecoveryStrategySchema,
  explanation: z.string().describe("Operational justification for the selected recovery strategy"),
  recommendedDelaySeconds: z.number().int().min(0).max(86400).default(0),
});

export type ProposalOutput = z.infer<typeof ProposalOutputSchema>;
