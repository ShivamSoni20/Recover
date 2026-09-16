-- Prevent concurrent approvals/retries from creating multiple active provider actions.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_actions_one_active_per_case
ON public.recovery_actions (case_id)
WHERE status IN ('CREATING', 'CREATED', 'UNCERTAIN', 'PAID');
