import { formatINR } from "./types";
import type { GateCheck, VerificationCheck } from "./types";

export function buildGateChecks(amountMinor: number): GateCheck[] {
  return [
    { id: "paid", label: "Already paid?", answer: "NO", passed: true },
    { id: "dup", label: "Duplicate recovery?", answer: "NO", passed: true },
    { id: "sibling", label: "Captured sibling payment?", answer: "NO", passed: true },
    {
      id: "attempts",
      label: "Attempts under limit?",
      answer: "YES",
      detail: "0 / 2",
      passed: true,
    },
    { id: "strategy", label: "Recovery strategy allowed?", answer: "YES", passed: true },
    {
      id: "policy",
      label: "Amount inside policy?",
      answer: "YES",
      detail: `${formatINR(amountMinor)} ≤ ₹10,000`,
      passed: true,
    },
    { id: "safe", label: "Safe to retry?", answer: "YES", passed: true },
  ];
}

export function buildVerificationChecks(amountMinor: number): VerificationCheck[] {
  return [
    { id: "event", label: "Payment event received", result: "received" },
    { id: "canonical", label: "Fetching canonical payment state", result: "Payment captured" },
    { id: "amount", label: "Checking amount", result: formatINR(amountMinor) },
    { id: "link", label: "Checking payment relationship", result: "linked to recovery action" },
    { id: "duplicate", label: "Checking duplicate collection", result: "none detected" },
    { id: "receipt", label: "Generating verification receipt", result: "generated" },
  ];
}

export const MACHINE_STEPS = [
  "Failure received",
  "Canonical state loaded",
  "AI diagnosis running",
  "Recovery strategy selected",
  "Recovery Gate evaluating",
];

export const DIAGNOSIS_EVIDENCE = [
  "payment failed",
  "original order unpaid",
  "no successful payment found",
  "recovery attempts: 0",
];
