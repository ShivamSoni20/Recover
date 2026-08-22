-- ============================================================================
-- Recover Database Migration 00002: Hardening, Security, and Robust RAG
-- ============================================================================

-- 1. Security: Drop public SELECT access on sensitive operational tables
DROP POLICY IF EXISTS "Allow public read on cases" ON public.recovery_cases;
DROP POLICY IF EXISTS "Allow public read on case_events" ON public.case_events;
DROP POLICY IF EXISTS "Allow public read on receipts" ON public.verification_receipts;
DROP POLICY IF EXISTS "Allow public read on diagnoses" ON public.recovery_diagnoses;
DROP POLICY IF EXISTS "Allow public read on actions" ON public.recovery_actions;
DROP POLICY IF EXISTS "Allow public read on authorizations" ON public.action_authorizations;
DROP POLICY IF EXISTS "Allow public read on policies" ON public.recovery_policy_versions;
DROP POLICY IF EXISTS "Allow public read on knowledge_chunks" ON public.knowledge_chunks;

-- 2. Ensure RLS is active on all tables
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

-- 3. Idempotency Constraint on Knowledge Chunks
ALTER TABLE IF EXISTS public.knowledge_chunks 
DROP CONSTRAINT IF EXISTS unq_knowledge_chunk_doc_idx;

ALTER TABLE IF EXISTS public.knowledge_chunks 
ADD CONSTRAINT unq_knowledge_chunk_doc_idx UNIQUE (document_id, chunk_index);

-- 4. Constraint: Exactly one active recovery policy at a time
CREATE UNIQUE INDEX IF NOT EXISTS unq_idx_single_active_policy 
ON public.recovery_policy_versions (is_active) 
WHERE is_active = true;

-- 5. Hardened RAG function returning document source and content with cosine similarity
DROP FUNCTION IF EXISTS match_knowledge_chunks(vector, double precision, integer);
DROP FUNCTION IF EXISTS match_knowledge_chunks(vector, float, int);

CREATE OR REPLACE FUNCTION match_knowledge_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  source text,
  title text,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    kc.id,
    kc.document_id,
    kd.source,
    kd.title,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  INNER JOIN knowledge_documents kd ON kd.id = kc.document_id
  WHERE 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
