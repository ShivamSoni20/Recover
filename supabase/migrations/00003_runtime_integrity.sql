-- ============================================================================
-- Recover Database Migration 00003: Runtime Integrity & Provider Tracking
-- ============================================================================

-- 1. Add direct payment & case resolution tracking to test_payment_sessions
ALTER TABLE IF EXISTS public.test_payment_sessions 
ADD COLUMN IF NOT EXISTS original_payment_id TEXT,
ADD COLUMN IF NOT EXISTS recovery_case_id UUID REFERENCES public.recovery_cases(id) ON DELETE SET NULL;

-- 2. Add accepted provider success event id to recovery_actions to prevent double-resumes
ALTER TABLE IF EXISTS public.recovery_actions
ADD COLUMN IF NOT EXISTS accepted_success_event_id TEXT;

-- 3. Unique index to guarantee at most one successful verification receipt per case
CREATE UNIQUE INDEX IF NOT EXISTS unq_idx_verified_receipt_per_case 
ON public.verification_receipts(case_id) 
WHERE status = 'VERIFIED';
