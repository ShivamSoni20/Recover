-- ============================================================================
-- Recover Database Migration 00001: Initial Domain Schema & pgvector
-- ============================================================================

-- Enable pgvector extension for RAG embeddings
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 1. Recovery Policy Versions (Immutable configuration)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_policy_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_tag TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT false,
    max_recovery_attempts INTEGER NOT NULL DEFAULT 2,
    max_autonomous_amount_minor BIGINT NOT NULL DEFAULT 1000000, -- 10,000 INR
    require_approval_above_minor BIGINT NOT NULL DEFAULT 0,       -- 0 = human approval on all recoveries
    allow_fresh_checkout BOOLEAN NOT NULL DEFAULT true,
    link_expiry_minutes INTEGER NOT NULL DEFAULT 60,
    min_diagnosis_confidence NUMERIC(4, 2) NOT NULL DEFAULT 0.70,
    block_risk_or_policy_failures BOOLEAN NOT NULL DEFAULT true,
    block_unknown_failures BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial default test policy if not present
INSERT INTO recovery_policy_versions (
    version_tag,
    is_active,
    max_recovery_attempts,
    max_autonomous_amount_minor,
    require_approval_above_minor,
    allow_fresh_checkout,
    link_expiry_minutes,
    min_diagnosis_confidence,
    block_risk_or_policy_failures,
    block_unknown_failures
) VALUES (
    'policy-v1.0.0-test',
    true,
    2,
    1000000,
    0,
    true,
    60,
    0.70,
    true,
    true
) ON CONFLICT (version_tag) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Test Payment Sessions (Initial checkout session tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_payment_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL UNIQUE,
    order_id TEXT NOT NULL UNIQUE,
    amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    description TEXT,
    customer_name TEXT,
    customer_email TEXT,
    customer_purpose TEXT,
    status TEXT NOT NULL DEFAULT 'CREATED', -- CREATED, ATTEMPTED, FAILED, PAID
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 3. Webhook Events (Idempotency & Auditing)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_event_id TEXT NOT NULL UNIQUE, -- x-razorpay-event-id
    event_type TEXT NOT NULL,
    signature_valid BOOLEAN NOT NULL DEFAULT true,
    raw_payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- 4. Recovery Cases (Central Domain Object & LangGraph Thread Root)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_number TEXT NOT NULL UNIQUE, -- e.g. RCV-12345
    thread_id TEXT NOT NULL UNIQUE,   -- LangGraph thread_id (matches id or uuid)
    original_order_id TEXT NOT NULL,
    original_payment_id TEXT NOT NULL UNIQUE,
    amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    customer_name TEXT,
    customer_email TEXT,
    customer_purpose TEXT,
    description TEXT,
    failure_reason TEXT,
    failure_detail TEXT,
    method TEXT,
    failed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'PAYMENT_FAILED',
    -- Terminal status: RECOVERED_VERIFIED, STOPPED_ALREADY_PAID, MANUAL_REVIEW, DOUBLE_PAYMENT_RISK, FAILED_SAFE
    terminal_status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 5. Recovery Diagnoses (AI Structured Output)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_diagnoses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
    failure_class TEXT NOT NULL,
    confidence NUMERIC(4, 2) NOT NULL,
    evidence_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    knowledge_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    summary TEXT NOT NULL,
    raw_llm_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 6. Action Authorizations (Deterministic Recovery Gate Authorizations)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
    policy_version_id UUID NOT NULL REFERENCES recovery_policy_versions(id),
    strategy TEXT NOT NULL,
    exact_amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    canonical_state_hash TEXT NOT NULL,
    authorized BOOLEAN NOT NULL DEFAULT false,
    requires_approval BOOLEAN NOT NULL DEFAULT true,
    reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
    gate_checks JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- 7. Recovery Decisions (Human Review Interrupt Action)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
    decision TEXT NOT NULL, -- APPROVE_RECOVERY, ESCALATE, REJECT
    actor TEXT NOT NULL DEFAULT 'operator',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 8. Recovery Actions (Created Razorpay Payment Links)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
    authorization_id UUID REFERENCES action_authorizations(id),
    reference_id TEXT NOT NULL UNIQUE, -- rcv_caseid_attempt
    payment_link_id TEXT UNIQUE,       -- plink_xxx
    short_url TEXT,
    amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'CREATED', -- NOT_STARTED, CREATING, CREATED, UNCERTAIN, PAID, CANCELLED, FAILED
    recovery_payment_id TEXT UNIQUE,   -- pay_xxx when paid
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 9. Verification Receipts (Cryptographic & Independent Audit Proof)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL UNIQUE REFERENCES recovery_cases(id) ON DELETE CASCADE,
    original_order_id TEXT NOT NULL,
    original_payment_id TEXT NOT NULL,
    recovery_link_id TEXT NOT NULL,
    recovery_payment_id TEXT NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    checks_passed JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'VERIFIED', -- VERIFIED, FAILED, DOUBLE_PAYMENT_RISK
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 10. Case Events (Append-Only Operational Audit Timeline)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    label TEXT NOT NULL,
    data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_events_case_id ON case_events(case_id, created_at ASC);

-- ----------------------------------------------------------------------------
-- 11. Knowledge Documents & Chunks (RAG with pgvector)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding vector(1536), -- OpenRouter text-embedding-3-small dimension
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding 
ON knowledge_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- ----------------------------------------------------------------------------
-- 12. Row Level Security (RLS) - Deny Anonymous Direct Mutation
-- ----------------------------------------------------------------------------
ALTER TABLE recovery_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_payment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- Allow read-only access for anon client if needed, backend uses service_role
CREATE POLICY "Allow public read-only on cases" ON recovery_cases FOR SELECT USING (true);
CREATE POLICY "Allow public read-only on case_events" ON case_events FOR SELECT USING (true);
CREATE POLICY "Allow public read-only on receipts" ON verification_receipts FOR SELECT USING (true);
CREATE POLICY "Allow public read-only on diagnoses" ON recovery_diagnoses FOR SELECT USING (true);
CREATE POLICY "Allow public read-only on actions" ON recovery_actions FOR SELECT USING (true);
