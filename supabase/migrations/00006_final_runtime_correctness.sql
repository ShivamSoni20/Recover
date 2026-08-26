-- ============================================================================
-- Recover Database Migration 00006: Final Runtime Correctness, Schema Integrity & Security
-- ============================================================================

-- 1. Schema alignment for verification_receipts
ALTER TABLE public.verification_receipts
ADD COLUMN IF NOT EXISTS action_id UUID REFERENCES public.recovery_actions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_verification_receipts_action_id
ON public.verification_receipts(action_id);

-- 2. Schema alignment for recovery_actions retryable workflow application
ALTER TABLE public.recovery_actions
ADD COLUMN IF NOT EXISTS workflow_event_applied_at TIMESTAMPTZ;

-- 3. Capability protection for test_payment_sessions
ALTER TABLE public.test_payment_sessions
ADD COLUMN IF NOT EXISTS capability_token_hash TEXT;

-- 4. Hardened, Leased Webhook Claim RPC
CREATE OR REPLACE FUNCTION public.claim_webhook_event(
  p_provider_event_id TEXT,
  p_event_type TEXT,
  p_raw_payload JSONB
)
RETURNS TABLE (
  claimed BOOLEAN,
  current_status TEXT,
  attempt_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.webhook_events%ROWTYPE;
BEGIN
  -- 1. Insert initial inbox record if not exists
  INSERT INTO public.webhook_events (
    provider_event_id,
    event_type,
    signature_valid,
    raw_payload,
    processing_status,
    received_at
  )
  VALUES (
    p_provider_event_id,
    p_event_type,
    true,
    p_raw_payload,
    'RECEIVED',
    NOW()
  )
  ON CONFLICT (provider_event_id) DO NOTHING;

  -- 2. Atomically transition to PROCESSING from allowed states OR stale PROCESSING lease (> 2 mins)
  UPDATE public.webhook_events
  SET
    processing_status = 'PROCESSING',
    processing_started_at = NOW(),
    attempt_count = webhook_events.attempt_count + 1
  WHERE provider_event_id = p_provider_event_id
    AND (
      processing_status IN ('RECEIVED', 'FAILED_RETRYABLE')
      OR (
        processing_status = 'PROCESSING'
        AND processing_started_at < (NOW() - INTERVAL '2 minutes')
      )
    )
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, v_row.processing_status, v_row.attempt_count;
    RETURN;
  END IF;

  -- 3. If not claimed, select current state to inform the caller
  SELECT * INTO v_row
  FROM public.webhook_events
  WHERE provider_event_id = p_provider_event_id;

  RETURN QUERY SELECT FALSE, v_row.processing_status, v_row.attempt_count;
  RETURN;
END;
$$;

-- 5. Strict Permission Hardening: service_role only
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(TEXT, TEXT, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_event(TEXT, TEXT, JSONB) TO service_role;
