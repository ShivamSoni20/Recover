import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import { fetchPaymentLink } from "../src/lib/razorpay/payment-links";
import { fetchRazorpayPayment } from "../src/lib/razorpay/payments";
import { supabase } from "../src/lib/db/supabase";
import server from "../src/server";

function signWebhook(payload: any, secret: string): string {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFinishGolden() {
  console.log("================================================================================");
  console.log("🚀 PROCESSING REAL CAPTURED PAYMENT ON RAZORPAY TEST PAYMENT LINK");
  console.log("================================================================================\n");

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET is required");

  const paymentLinkId = "plink_TUkBKDQpEPJB4l";
  const recoveryPaymentId = "pay_TUlRJ9c5BicBo5";
  const caseId = "d560bf4c-5008-4b9c-a43c-d08cca41dce7";

  console.log("Step 1: Fetching live Payment Link & Payment from Razorpay...");
  const liveLink = await fetchPaymentLink(paymentLinkId);
  const livePayment = await fetchRazorpayPayment(recoveryPaymentId);
  console.log(`✅ Real Payment Link: ${liveLink.id} (status: ${liveLink.status})`);
  console.log(
    `✅ Real Recovery Payment: ${livePayment.id} (status: ${livePayment.status}, captured: ${livePayment.captured}, amount: ₹${livePayment.amount / 100})`,
  );

  console.log("\nStep 2: Posting signed payment_link.paid webhook with real provider entities...");
  const successWebhookEventId = `evt_gold_paid_live_${Date.now()}`;
  const successWebhookPayload = {
    entity: "event",
    account_id: "acc_test",
    event: "payment_link.paid",
    contains: ["payment_link", "payment"],
    payload: {
      payment_link: {
        entity: liveLink,
      },
      payment: {
        entity: livePayment,
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };

  const rawBody = JSON.stringify(successWebhookPayload);
  const signature = signWebhook(rawBody, secret);

  const req = new Request("http://localhost:3000/api/webhooks/razorpay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": successWebhookEventId,
    },
    body: rawBody,
  });

  const res = await server.fetch(req, {}, {});
  console.log(`✅ Webhook Response Status: ${res.status}`);
  const resJson = await res.json();
  console.log("   Webhook Response:", resJson);

  console.log("\nStep 3: Polling Supabase for Verification Receipt & RECOVERED_VERIFIED Status...");
  let verifiedCase: any = null;
  let receipt: any = null;

  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const { data: rc } = await supabase
      .from("recovery_cases")
      .select(
        `
        *,
        verification_receipts(*),
        recovery_actions(*)
      `,
      )
      .eq("id", caseId)
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

runFinishGolden().catch((err) => {
  console.error("❌ Failed to finish golden run:", err);
  process.exit(1);
});
