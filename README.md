# Recover

> **A failed payment that knows what to do next.**
> *Razorpay AI Buildathon — Track 03: AI Revenue Recovery*

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
        ↓
PAYMENT FAILED
        ↓
Signed Razorpay Webhook (HMAC SHA-256 validated against raw body)
        ↓
Canonical Razorpay Payment Fetch (GET /v1/payments/:id)
        ↓
Supabase Database Persistence (recovery_cases, webhook_events)
        ↓
LangGraph Workflow Execution (Durable thread per recovery case with PostgresSaver)
        ↓
RAG-supported Context Retrieval (pgvector + OpenRouter Embeddings)
        ↓
LangChain + OpenRouter Diagnosis (Structured JSON via Zod)
        ↓
DETERMINISTIC Recovery Gate (Strict policy bounds, no LLM financial authority)
        ↓
Human Approval Interrupt (await_approval)
        ↓
Canonical Pre-Action Revalidation (Re-fetch original payment/order state)
        ↓
Real Razorpay Payment Link Created (POST /v1/payment_links with idempotent reference_id)
        ↓
Customer Pays Successfully on Hosted Razorpay Link
        ↓
Real paid/captured Webhook Arrives
        ↓
LangGraph Resumes Workflow
        ↓
Independent Razorpay Re-fetch & Comparison (Expected vs Observed)
        ↓
Verification Receipt Persisted
        ↓
RECOVERED — VERIFIED
```

---

## Why LangChain, LangGraph & RAG?

| Component | Responsibility | What It Must NOT Do |
|---|---|---|
| **LangChain** | Model abstraction, structured schema output (Zod), prompt composition, and embedding interfaces. | Cannot mutate money, execute orders, or authorize financial transactions. |
| **LangGraph** | Durable multi-step state machine, human approval interrupts, long-running wait states for customer checkout, and webhook resumes. | Does not fabricate financial success without provider proof. |
| **RAG (pgvector)** | Curated failure runbooks and merchant policy retrieval to provide contextual error diagnosis. | Does not make policy decisions or override deterministic rules. |
| **Recovery Gate** | Pure deterministic code evaluating provider state, attempt limits, amount thresholds, and risk filters. | Does not invoke the LLM. |

---

## Tech Stack

- **Frontend**: React 19, TanStack Start, TanStack Router, TanStack Query, Tailwind CSS 4, Radix UI.
- **Workflow & AI**: LangGraph.js, LangChain.js, OpenRouter (`ChatOpenAI`), OpenRouter Embeddings.
- **Database & Persistence**: Supabase PostgreSQL, `pgvector`, `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`).
- **Payments**: Razorpay Test Mode API (Orders, Payments, Payment Links), Raw HMAC SHA-256 Webhook Verification.
- **Testing**: Vitest.

---

## Environment Variables Setup

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Fill in the required credentials:

```ini
# Application Base URL
APP_BASE_URL=http://localhost:3000

# OpenRouter AI Configuration
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
OPENROUTER_APP_TITLE=Recover

# Supabase & PostgreSQL (Domain DB + pgvector + Checkpoints)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres

# Razorpay Test Mode
RECOVER_RAZORPAY_MODE=test
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
```

---

## Database Migrations

Run the SQL migration in `supabase/migrations/00001_initial_schema.sql` on your Supabase project (via Supabase SQL Editor or Supabase CLI):

```bash
# Contains:
# - vector & uuid-ossp extensions
# - recovery_cases, webhook_events, action_authorizations, verification_receipts
# - LangGraph checkpoint tables & RLS policies
```

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
2. Enter an amount (e.g. `₹7,350`) and customer details.
3. Click **Create ₹7,350 Test Payment** → A real Razorpay Order (`order_xxx`) is created.
4. Click **Open Test Checkout** → Standard Razorpay Test Checkout opens.
5. In the Razorpay modal, select a failure option (or close to simulate failure).
6. Razorpay sends the signed `payment.failed` webhook to `/api/webhooks/razorpay`.
7. Recover verifies the HMAC signature, fetches canonical state, creates a `recovery_case`, and launches the LangGraph workflow.
8. Open `/demo/payment/:id` → See real OpenRouter diagnosis, RAG knowledge references, and the deterministic Recovery Gate authorization.
9. Click **Recover ₹7,350** → Rechecks original payment status and creates a real Razorpay Payment Link (`plink_xxx`).
10. Click **Open Recovery Checkout** → Complete the payment on the hosted link.
11. Razorpay sends `payment_link.paid` → LangGraph resumes, runs canonical verification, persists an independent verification receipt, and displays **RECOVERED — VERIFIED**.
