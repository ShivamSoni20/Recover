import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import { fetchRazorpayOrder } from "../src/lib/razorpay/orders";
import { fetchRazorpayPayment } from "../src/lib/razorpay/payments";
import { fetchPaymentLink } from "../src/lib/razorpay/payment-links";
import { supabase } from "../src/lib/db/supabase";
import server from "../src/server";
import { resumeWorkflowWithDecision } from "../src/lib/graph/runner";

function signWebhook(payload: any, secret: string): string {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGoldenE2E() {
  console.log("================================================================================");
  console.log("🚀 STARTING REAL GOLDEN E2E TEST: RECOVER AUTONOMOUS REVENUE RECOVERY");
  console.log("================================================================================\n");

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET is required.");
  }

  const orderId = "order_TT4E29j9i65Qgo";
  const failedPaymentId = "pay_TT4FQqwGZ9jEHW";

  // Clean up any previous test state for clean reproducible test
  await supabase.from("verification_receipts").delete().eq("original_order_id", orderId);
  const { data: oldCases } = await supabase
    .from("recovery_cases")
    .select("id")
    .eq("original_order_id", orderId);
  if (oldCases && oldCases.length > 0) {
    for (const c of oldCases) {
      await supabase.from("verification_receipts").delete().eq("case_id", c.id);
      await supabase.from("recovery_actions").delete().eq("case_id", c.id);
      await supabase.from("action_authorizations").delete().eq("case_id", c.id);
      await supabase.from("recovery_diagnoses").delete().eq("case_id", c.id);
      await supabase.from("recovery_decisions").delete().eq("case_id", c.id);
      await supabase.from("case_events").delete().eq("case_id", c.id);
      await supabase.from("recovery_cases").delete().eq("id", c.id);
    }
  }
  await supabase.from("test_payment_sessions").delete().eq("order_id", orderId);

  // 1. Fetch Real Razorpay Test Mode Order
  console.log(`Step 1: Fetching canonical Razorpay Order (${orderId})...`);
  const order = await fetchRazorpayOrder(orderId);
  console.log(
    `✅ Real Razorpay Order Fetched: ${order.id} (amount: ₹${order.amount / 100}, status: ${order.status})`,
  );

  // 2. Persist durable test_payment_sessions in live Supabase
  console.log("\nStep 2: Persisting durable test_payment_sessions in Supabase...");
  const sessionId = crypto.randomUUID();
  const capToken = `cap_${crypto.randomUUID()}`;
  const capHash = crypto.createHash("sha256").update(capToken).digest("hex");

  const { data: session, error: sessErr } = await supabase
    .from("test_payment_sessions")
    .insert({
      session_id: sessionId,
      order_id: order.id,
      amount_minor: order.amount,
      currency: order.currency,
      description: "Golden E2E Verification Test",
      customer_name: "Amit Sharma",
      customer_email: "amit@example.com",
      customer_purpose: "Pro Plan — Annual",
      status: "CREATED",
      capability_token_hash: capHash,
    })
    .select("id, session_id, order_id")
    .single();

  if (sessErr || !session) {
    throw new Error(`Failed to insert session: ${sessErr?.message}`);
  }
  console.log(`✅ Durable Session Persisted: ID=${session.id}, SessionID=${sessionId}`);

  // 3. Fetch Real Failed Payment from Razorpay Test Mode
  console.log("\nStep 3: Fetching canonical real failed payment from Razorpay...");
  const failedPayment = await fetchRazorpayPayment(failedPaymentId);
  console.log(
    `✅ Real Failed Payment Fetched: ${failedPayment.id} (status=${failedPayment.status}, error_code=${failedPayment.error_code})`,
  );

  // 4. Ingest signed payment.failed webhook
  console.log("\nStep 4: Posting signed payment.failed webhook to server.fetch...");
  const webhookEventId = `evt_gold_fail_${Date.now()}`;
  const failedWebhookPayload = {
    entity: "event",
    account_id: "acc_test",
    event: "payment.failed",
    contains: ["payment"],
    payload: {
      payment: {
        entity: failedPayment,
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };

  const rawBody = JSON.stringify(failedWebhookPayload);
  const signature = signWebhook(rawBody, secret);

  const failReq = new Request("http://localhost:3000/api/webhooks/razorpay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": webhookEventId,
    },
    body: rawBody,
  });

  const failRes = await server.fetch(failReq, {}, {});
  console.log(`✅ Webhook Response Status: ${failRes.status}`);
  const failResJson = await failRes.json();
  console.log("   Webhook Response:", failResJson);

  // 5. Poll Supabase for Recovery Case Creation & LangGraph progression to WAITING_APPROVAL
  console.log(
    "\nStep 5: Waiting for LangGraph (Canonicalize -> RAG -> Diagnosis -> Recovery Gate -> WAITING_APPROVAL)...",
  );
  let recoveryCase: any = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const { data: rc } = await supabase
      .from("recovery_cases")
      .select(
        `
        *,
        recovery_diagnoses(*),
        action_authorizations(*),
        case_events(*)
      `,
      )
      .eq("original_order_id", order.id)
      .maybeSingle();

    if (rc && rc.status === "WAITING_APPROVAL") {
      recoveryCase = rc;
      break;
    }
  }

  if (!recoveryCase) {
    throw new Error("Recovery case did not reach WAITING_APPROVAL within timeout.");
  }

  console.log(`✅ Recovery Case Created & Waiting Approval:`);
  console.log(`   - Case ID: ${recoveryCase.id}`);
  console.log(`   - Case Number: ${recoveryCase.case_number}`);
  console.log(`   - Status: ${recoveryCase.status}`);
  console.log(
    `   - Diagnosis: ${recoveryCase.recovery_diagnoses?.[0]?.failure_class} (confidence=${recoveryCase.recovery_diagnoses?.[0]?.confidence})`,
  );
  console.log(`   - Strategy: ${recoveryCase.action_authorizations?.[0]?.strategy}`);
  console.log(`   - Authorized: ${recoveryCase.action_authorizations?.[0]?.authorized}`);
  console.log(`   - State Hash: ${recoveryCase.action_authorizations?.[0]?.canonical_state_hash}`);

  // 6. Execute Merchant Approval
  console.log("\nStep 6: Executing Merchant Approval (APPROVE_RECOVERY)...");
  await resumeWorkflowWithDecision(recoveryCase.id, "APPROVE_RECOVERY");
  console.log("✅ Approval Submitted: resumeWorkflowWithDecision executed successfully");

  // 7. Poll for Preflight Revalidation & Real Razorpay Payment Link Creation
  console.log(
    "\nStep 7: Waiting for Preflight Revalidation & Real Razorpay Payment Link Creation...",
  );
  let recoveryAction: any = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const { data: act } = await supabase
      .from("recovery_actions")
      .select("*")
      .eq("case_id", recoveryCase.id)
      .eq("status", "CREATED")
      .maybeSingle();

    if (act && act.payment_link_id) {
      recoveryAction = act;
      break;
    }
  }

  if (!recoveryAction) {
    throw new Error("Recovery action with created Payment Link not found.");
  }

  console.log(`✅ Real Razorpay Payment Link Created:`);
  console.log(`   - Payment Link ID: ${recoveryAction.payment_link_id}`);
  console.log(`   - Hosted Short URL: ${recoveryAction.short_url}`);
  console.log(`   - Reference ID: ${recoveryAction.reference_id}`);
  console.log(`   - Status: ${recoveryAction.status}`);

  // Fetch Payment Link directly from Razorpay API to confirm live provider presence
  const liveLink = await fetchPaymentLink(recoveryAction.payment_link_id);
  console.log(
    `   - Live Razorpay Link Status: ${liveLink.status}, Amount: ₹${liveLink.amount / 100}`,
  );

  // 8. Ingest signed payment_link.paid webhook
  console.log(
    "\nStep 8: Customer pays on hosted link -> Posting signed payment_link.paid webhook...",
  );
  const recoveryPaymentId = `pay_gold_rec_${Date.now()}`;
  const successWebhookEventId = `evt_gold_paid_${Date.now()}`;

  const successWebhookPayload = {
    entity: "event",
    account_id: "acc_test",
    event: "payment_link.paid",
    contains: ["payment_link", "payment"],
    payload: {
      payment_link: {
        entity: {
          ...liveLink,
          status: "paid",
          amount_paid: liveLink.amount,
          payments: [
            {
              payment_id: recoveryPaymentId,
              amount: liveLink.amount,
              status: "captured",
              created_at: Math.floor(Date.now() / 1000),
            },
          ],
        },
      },
      payment: {
        entity: {
          id: recoveryPaymentId,
          entity: "payment",
          amount: liveLink.amount,
          currency: "INR",
          status: "captured",
          captured: true,
          method: "card",
          notes: {
            payment_link_id: recoveryAction.payment_link_id,
            case_id: recoveryCase.id,
          },
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };

  const successRawBody = JSON.stringify(successWebhookPayload);
  const successSig = signWebhook(successRawBody, secret);

  const successReq = new Request("http://localhost:3000/api/webhooks/razorpay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": successSig,
      "x-razorpay-event-id": successWebhookEventId,
    },
    body: successRawBody,
  });

  const successRes = await server.fetch(successReq, {}, {});
  console.log(`✅ Success Webhook Status: ${successRes.status}`);
  const successResJson = await successRes.json();
  console.log("   Success Webhook Response:", successResJson);

  // 9. Poll for Verification Receipt and Final RECOVERED_VERIFIED Status
  console.log("\nStep 9: Waiting for Independent Verification & Immutable Receipt Generation...");
  let verifiedCase: any = null;
  let receipt: any = null;

  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const { data: rc } = await supabase
      .from("recovery_cases")
      .select(
        `
        *,
        verification_receipts(*)
      `,
      )
      .eq("id", recoveryCase.id)
      .maybeSingle();

    if (rc && rc.terminal_status === "RECOVERED_VERIFIED" && rc.verification_receipts?.length > 0) {
      verifiedCase = rc;
      receipt = rc.verification_receipts[0];
      break;
    }
  }

  if (!verifiedCase || !receipt) {
    throw new Error("Verification receipt not generated or case did not reach RECOVERED_VERIFIED.");
  }

  console.log("\n================================================================================");
  console.log("🎉 GOLDEN E2E PROOF COMPLETED SUCCESSFULLY — RECOVERED_VERIFIED");
  console.log("================================================================================");
  console.log(`1. Case Number: ${verifiedCase.case_number}`);
  console.log(`2. Case ID: ${verifiedCase.id}`);
  console.log(`3. Terminal Status: ${verifiedCase.terminal_status}`);
  console.log(`4. Receipt ID: ${receipt.id}`);
  console.log(`5. Receipt Status: ${receipt.status}`);
  console.log(`6. Action ID: ${receipt.action_id}`);
  console.log(`7. Original Order ID: ${receipt.original_order_id}`);
  console.log(`8. Original Payment ID: ${receipt.original_payment_id}`);
  console.log(`9. Recovery Link ID: ${receipt.recovery_link_id}`);
  console.log(`10. Recovery Payment ID: ${receipt.recovery_payment_id}`);
  console.log(`11. Amount (Paise): ${receipt.amount_minor} (₹${receipt.amount_minor / 100})`);
  console.log(`12. Currency: ${receipt.currency}`);
  console.log(`13. Verified At: ${receipt.verified_at}`);
  console.log(`14. Deterministic Verification Checks:`);
  console.table(receipt.checks_passed);
  console.log("================================================================================\n");
}

runGoldenE2E().catch((err) => {
  console.error("❌ Golden E2E Test Failed:", err);
  process.exit(1);
});
