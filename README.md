# Recover

> **Real-provider proof:** `scripts/live-golden-e2e.ts` and `scripts/finish-golden-live.ts`
> are developer diagnostics that may manufacture webhook inputs. They do not prove Razorpay
> delivered a webhook. A golden E2E requires a fresh browser-created Test Order, an actual failed
> Razorpay Test Checkout payment, Razorpay-delivered failure and success webhooks to the deployed
> endpoint, one durable recovery action, a hosted Payment Link payment, and a persisted VERIFIED
> receipt ending in `RECOVERED_VERIFIED`.

> **Known hackathon-scope deferral:** public endpoint rate limiting still requires a durable,
> deployment-wide store. Do not expose the demo broadly until a DB-backed limiter is deployed for
> payment creation, reconciliation, and decisions; Vercel instance-local counters are insufficient.

> **A failed payment that knows what to do next.**
> _Razorpay AI Buildathon — Track 03: AI Revenue Recovery_

---

## Overview

**Recover** converts failed payments into verified recovered revenue using an agentic AI architecture with deterministic financial safety boundaries.

### Core Product Principle

- **AI CHOOSES THE RECOVERY STRATEGY.**
- **CODE DECIDES WHETHER IT MAY EXECUTE.**
- **RAZORPAY PROVES WHETHER RECOVERY ACTUALLY HAPPENED.**

---

## The Core Loop & Architecture

```
Real Razorpay Test payment
        │
PAYMENT FAILED
        │
Signed Razorpay Webhook (HMAC SHA-256 validated against raw body)
        │
Canonical Razorpay Payment Fetch (GET /v1/payments/:id)
        │
Supabase Database Persistence (recovery_cases, webhook_events)
        │
LangGraph Workflow Execution (Durable thread per recovery case with PostgresSaver)
        │
RAG-supported Context Retrieval (pgvector + OpenRouter Embeddings)
        │
LangChain + OpenRouter Diagnosis (Structured JSON via Zod)
        │
DETERMINISTIC Recovery Gate (Strict policy bounds, no LLM financial authority)
        │
Human Approval Interrupt (await_approval)
        │
Canonical Pre-Action Revalidation (Re-fetch original payment/order state, hash & expiry check)
        │
Real Razorpay Payment Link Created (POST /v1/payment_links with idempotent reference_id)
        │
Customer Pays Successfully on Hosted Razorpay Link
        │
Real paid/captured Webhook Arrives
        │
LangGraph Resumes Workflow on Same Thread
        │
Independent Razorpay Re-fetch & Comparison (Expected vs Observed, Relationship check)
        │
Verification Receipt Persisted
        │
RECOVERED — VERIFIED
```

---

## Why LangChain, LangGraph & RAG?

| Component          | Responsibility                                                                                                                    | What It Must NOT Do                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **LangChain**      | Model abstraction, structured schema output (Zod), prompt composition, and embedding interfaces.                                  | Cannot mutate money, execute orders, or authorize financial transactions. |
| **LangGraph**      | Durable multi-step state machine, human approval interrupts, long-running wait states for customer checkout, and webhook resumes. | Does not fabricate financial success without provider proof.              |
| **RAG (pgvector)** | Curated failure runbooks and merchant policy retrieval to provide contextual error diagnosis.                                     | Does not make policy decisions or override deterministic rules.           |
| **Recovery Gate**  | Pure deterministic code evaluating provider state, attempt limits, amount thresholds, and risk filters.                           | Does not invoke the LLM.                                                  |

---

## Tech Stack

- **Frontend**: React 19, TanStack Start, TanStack Router, TanStack Query, Tailwind CSS 4, Radix UI.
- **Workflow & AI**: LangGraph.js, LangChain.js, OpenRouter (`ChatOpenAI`), OpenRouter Embeddings.
- **Database & Persistence**: Supabase PostgreSQL, `pgvector`, `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`).
- **Payments**: Razorpay Test Mode API (Orders, Payments, Payment Links), Raw HMAC SHA-256 Webhook Verification.
- **Testing**: Vitest.

---

## Database Migrations & Schema

The database schema is managed via tracked migrations in `supabase/migrations/`:

1. **`00001_initial_schema.sql`**: Core domain tables (`test_payment_sessions`, `recovery_cases`, `case_events`, `webhook_events`, `action_authorizations`, `recovery_actions`, `verification_receipts`, `knowledge_documents`, `knowledge_chunks`, pgvector extensions and indices).
2. **`00002_hardening.sql`**: Idempotency indices, foreign key cascades, and check constraints.
3. **`00003_runtime_integrity.sql`**: Runtime audit tables and deterministic state tracking.
4. **`00004_backend_integrity.sql`**: RLS security cleanup, durable session invariants, and partial unique constraints.
5. **`00005_webhook_claim_rpc.sql`**: Atomic webhook event claim RPC.
6. **`00006_final_runtime_correctness.sql`**: Leased webhook claim recovery (> 2 min lease), service_role security hardening, `verification_receipts.action_id`, and `recovery_actions.workflow_event_applied_at`.

_Note: LangGraph durable checkpoint tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`) are auto-initialized via `PostgresSaver.setup()`._

---

## Running the Application

```bash
# Install dependencies
bun install # or npm install

# Run unit tests
bun run test

# Start the dev server
bun run dev
```

---

## Manual End-to-End Test Mode Walkthrough

1. Open `/demo/create` in your browser.
2. Enter an amount (e.g. `₹500`) and customer details.
3. Click **Create Test Payment** → A real Razorpay Order (`order_xxx`) and durable session are created.
4. Click **Open Test Checkout** → Standard Razorpay Test Checkout opens.
5. In the Razorpay modal, attempt a test transaction and select a deliberate Failure response.
6. Razorpay sends the signed `payment.failed` webhook to `/api/webhooks/razorpay` (or canonical reconciliation triggers).
7. Recover verifies the HMAC signature, fetches canonical state, creates a `recovery_case`, and launches the LangGraph workflow.
8. Open `/demo/payment/:id` → See real OpenRouter diagnosis, RAG knowledge references, and the deterministic Recovery Gate authorization.
9. Click **Recover** → Rechecks original payment status, state hash, and creates a real Razorpay Payment Link (`plink_xxx`).
10. Click **Open Hosted Recovery Checkout** → Complete the payment on the hosted Razorpay link.
11. Razorpay sends `payment_link.paid` → LangGraph resumes on the same thread, executes independent canonical verification, persists a schema-compliant verification receipt, and displays **RECOVERED — VERIFIED**.
