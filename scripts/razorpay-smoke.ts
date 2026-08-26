import dotenv from "dotenv";
import { createRazorpayOrder, fetchRazorpayOrder } from "../src/lib/razorpay/orders";
import {
  createRecoveryPaymentLink,
  fetchPaymentLink,
  cancelPaymentLink,
} from "../src/lib/razorpay/payment-links";

dotenv.config();

async function runRazorpaySmoke() {
  console.log("=== Razorpay Test Mode Smoke Test ===");

  if (process.env.RUN_RAZORPAY_INTEGRATION_TESTS !== "true") {
    console.log(
      "Skipping live Razorpay API calls. Set RUN_RAZORPAY_INTEGRATION_TESTS=true to execute.",
    );
    return;
  }

  // 1. Create Order
  console.log("1. Creating Test Order (₹7,350 = 735000 paise)...");
  const order = await createRazorpayOrder({
    amountMinor: 735000,
    currency: "INR",
    receipt: `smoke_${Date.now()}`,
    notes: { test: "smoke_run" },
  });
  console.log(`✓ Order Created: ${order.id}`);

  // 2. Fetch Order
  console.log("2. Fetching created order...");
  const fetchedOrder = await fetchRazorpayOrder(order.id);
  console.log(`✓ Order Fetched: ${fetchedOrder.id} status: ${fetchedOrder.status}`);

  // 3. Create Payment Link
  console.log("3. Creating Test Payment Link (₹7,350)...");
  const refId = `smoke_plink_${Date.now()}`;
  const link = await createRecoveryPaymentLink({
    amountMinor: 735000,
    currency: "INR",
    referenceId: refId,
    description: "Smoke Test Recovery Link",
  });
  console.log(`✓ Payment Link Created: ${link.id} URL: ${link.short_url}`);

  // 4. Fetch Link
  console.log("4. Fetching Payment Link...");
  const fetchedLink = await fetchPaymentLink(link.id);
  console.log(`✓ Link Fetched: ${fetchedLink.id} status: ${fetchedLink.status}`);

  // 5. Cancel Link
  console.log("5. Cancelling test link...");
  const cancelledLink = await cancelPaymentLink(link.id);
  console.log(`✓ Link Cancelled: ${cancelledLink.id} status: ${cancelledLink.status}`);

  console.log("\n=== All Razorpay Test Mode Smoke Tests Passed ===");
}

runRazorpaySmoke().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
