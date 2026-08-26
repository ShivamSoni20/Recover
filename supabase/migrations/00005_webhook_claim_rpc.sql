-- ============================================================================
-- Recover Database Migration 00005: Atomic Webhook Event Claim RPC
-- ============================================================================

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

  -- 2. Atomically transition to PROCESSING only from allowed initial or retryable states
  UPDATE public.webhook_events
  SET
    processing_status = 'PROCESSING',
    processing_started_at = NOW(),
    attempt_count = webhook_events.attempt_count + 1
  WHERE provider_event_id = p_provider_event_id
    AND processing_status IN ('RECEIVED', 'FAILED_RETRYABLE')
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, v_row.processing_status, v_row.attempt_count;
    RETURN;
  END IF;

  -- 3. If no row updated, retrieve current processing state for caller inspection
  SELECT * INTO v_row
  FROM public.webhook_events
  WHERE provider_event_id = p_provider_event_id;

  RETURN QUERY SELECT FALSE, v_row.processing_status, v_row.attempt_count;
  RETURN;
END;
$$;
