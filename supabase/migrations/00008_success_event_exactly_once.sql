-- Atomically assign one Razorpay success event to a recovery action.
CREATE OR REPLACE FUNCTION public.claim_recovery_success_event(
  p_action_id UUID,
  p_provider_event_id TEXT,
  p_payment_id TEXT
) RETURNS TABLE (
  claimed BOOLEAN,
  is_owner BOOLEAN,
  action_id UUID,
  case_id UUID,
  accepted_event_id TEXT,
  workflow_applied_at TIMESTAMPTZ,
  recovery_payment_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action public.recovery_actions%ROWTYPE;
BEGIN
  UPDATE public.recovery_actions
  SET accepted_success_event_id = p_provider_event_id,
      recovery_payment_id = p_payment_id,
      status = 'PAID',
      updated_at = NOW()
  WHERE id = p_action_id
    AND accepted_success_event_id IS NULL
  RETURNING * INTO v_action;

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, TRUE, v_action.id, v_action.case_id,
      v_action.accepted_success_event_id, v_action.workflow_event_applied_at,
      v_action.recovery_payment_id;
    RETURN;
  END IF;

  SELECT * INTO v_action
  FROM public.recovery_actions
  WHERE id = p_action_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT FALSE,
    v_action.accepted_success_event_id = p_provider_event_id,
    v_action.id, v_action.case_id, v_action.accepted_success_event_id,
    v_action.workflow_event_applied_at, v_action.recovery_payment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_recovery_success_event(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_recovery_success_event(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.claim_recovery_success_event(UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_recovery_success_event(UUID, TEXT, TEXT) TO service_role;
