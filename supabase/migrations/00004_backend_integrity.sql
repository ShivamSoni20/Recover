-- ============================================================================
-- Recover Database Migration 00004: Backend Integrity, Security, & Webhook Lifecycle
-- ============================================================================

-- 1. Security: Drop ALL historical public policy name variants from sensitive operational tables
DROP POLICY IF EXISTS "Allow public read on cases" ON public.recovery_cases;
DROP POLICY IF EXISTS "Allow public read-only on cases" ON public.recovery_cases;
DROP POLICY IF EXISTS "Allow public read on case_events" ON public.case_events;
DROP POLICY IF EXISTS "Allow public read-only on case_events" ON public.case_events;
DROP POLICY IF EXISTS "Allow public read on receipts" ON public.verification_receipts;
DROP POLICY IF EXISTS "Allow public read-only on receipts" ON public.verification_receipts;
DROP POLICY IF EXISTS "Allow public read on diagnoses" ON public.recovery_diagnoses;
DROP POLICY IF EXISTS "Allow public read-only on diagnoses" ON public.recovery_diagnoses;
DROP POLICY IF EXISTS "Allow public read on actions" ON public.recovery_actions;
DROP POLICY IF EXISTS "Allow public read-only on actions" ON public.recovery_actions;
DROP POLICY IF EXISTS "Allow public read on authorizations" ON public.action_authorizations;
DROP POLICY IF EXISTS "Allow public read-only on authorizations" ON public.action_authorizations;
DROP POLICY IF EXISTS "Allow public read on policies" ON public.recovery_policy_versions;
DROP POLICY IF EXISTS "Allow public read-only on policies" ON public.recovery_policy_versions;
DROP POLICY IF EXISTS "Allow public read on sessions" ON public.test_payment_sessions;
DROP POLICY IF EXISTS "Allow public read-only on sessions" ON public.test_payment_sessions;
DROP POLICY IF EXISTS "Allow public read on webhooks" ON public.webhook_events;
DROP POLICY IF EXISTS "Allow public read-only on webhooks" ON public.webhook_events;
DROP POLICY IF EXISTS "Allow public read on knowledge_chunks" ON public.knowledge_chunks;
DROP POLICY IF EXISTS "Allow public read-only on knowledge_chunks" ON public.knowledge_chunks;
DROP POLICY IF EXISTS "Allow public read on knowledge_documents" ON public.knowledge_documents;
DROP POLICY IF EXISTS "Allow public read-only on knowledge_documents" ON public.knowledge_documents;
DROP POLICY IF EXISTS "Allow public read on decisions" ON public.recovery_decisions;
DROP POLICY IF EXISTS "Allow public read-only on decisions" ON public.recovery_decisions;

-- 2. Ensure RLS is active on all operational tables
ALTER TABLE IF EXISTS public.recovery_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.test_payment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.recovery_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.recovery_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.action_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.recovery_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.recovery_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.verification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- 3. Extend webhook_events for durable retry lifecycle
ALTER TABLE IF EXISTS public.webhook_events
ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'RECEIVED',
ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error TEXT;

-- 4. Extend action_authorizations for cryptographic validity window
ALTER TABLE IF EXISTS public.action_authorizations
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 5. Business Invariant: At most one recovery case per initial Razorpay Order (excluding unknowns)
CREATE UNIQUE INDEX IF NOT EXISTS unq_idx_recovery_cases_order_id
ON public.recovery_cases (original_order_id)
WHERE original_order_id IS NOT NULL AND original_order_id != 'unknown' AND original_order_id != '';

-- 6. Performance and lookup indexes
CREATE INDEX IF NOT EXISTS idx_recovery_actions_payment_link ON public.recovery_actions(payment_link_id);
CREATE INDEX IF NOT EXISTS idx_recovery_actions_reference_id ON public.recovery_actions(reference_id);
CREATE INDEX IF NOT EXISTS idx_recovery_actions_accepted_event ON public.recovery_actions(accepted_success_event_id);
CREATE INDEX IF NOT EXISTS idx_test_payment_sessions_order_id ON public.test_payment_sessions(order_id);
CREATE INDEX IF NOT EXISTS idx_test_payment_sessions_session_id ON public.test_payment_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_payment_id ON public.recovery_cases(original_payment_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_id ON public.webhook_events(provider_event_id);
