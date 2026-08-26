import { supabase } from "../db/supabase";

export interface RecoveryPolicy {
  id: string;
  versionTag: string;
  maxRecoveryAttempts: number;
  maxAutonomousAmountMinor: number;
  requireApprovalAboveMinor: number;
  allowFreshCheckout: boolean;
  linkExpiryMinutes: number;
  minDiagnosisConfidence: number;
  blockRiskOrPolicyFailures: boolean;
  blockUnknownFailures: boolean;
}

export async function getActiveRecoveryPolicy(): Promise<RecoveryPolicy> {
  const { data, error } = await supabase
    .from("recovery_policy_versions")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    throw new Error(
      `[Recovery Policy] Active policy version not found in Supabase: ${error?.message || "No active policy row"}`,
    );
  }

  return {
    id: data.id,
    versionTag: data.version_tag,
    maxRecoveryAttempts: Number(data.max_recovery_attempts),
    maxAutonomousAmountMinor: Number(data.max_autonomous_amount_minor),
    requireApprovalAboveMinor: Number(data.require_approval_above_minor),
    allowFreshCheckout: Boolean(data.allow_fresh_checkout),
    linkExpiryMinutes: Number(data.link_expiry_minutes),
    minDiagnosisConfidence: Number(data.min_diagnosis_confidence),
    blockRiskOrPolicyFailures: Boolean(data.block_risk_or_policy_failures),
    blockUnknownFailures: Boolean(data.block_unknown_failures),
  };
}
