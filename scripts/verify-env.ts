import dotenv from "dotenv";
import { getRazorpayConfig } from "../src/lib/razorpay/client";

dotenv.config();

function verifyEnvironment() {
  console.log("=== Recover Environment Verification ===");

  const checks = [
    { name: "APP_BASE_URL", value: process.env.APP_BASE_URL, required: false },
    { name: "OPENROUTER_API_KEY", value: process.env.OPENROUTER_API_KEY, required: true },
    {
      name: "OPENROUTER_MODEL",
      value: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
      required: false,
    },
    { name: "SUPABASE_URL", value: process.env.SUPABASE_URL, required: true },
    {
      name: "SUPABASE_SERVICE_ROLE_KEY",
      value: process.env.SUPABASE_SERVICE_ROLE_KEY,
      required: true,
    },
    { name: "DATABASE_URL", value: process.env.DATABASE_URL, required: true },
    { name: "RECOVER_RAZORPAY_MODE", value: process.env.RECOVER_RAZORPAY_MODE, required: true },
    { name: "RAZORPAY_KEY_ID", value: process.env.RAZORPAY_KEY_ID, required: true },
    { name: "RAZORPAY_KEY_SECRET", value: process.env.RAZORPAY_KEY_SECRET, required: true },
    { name: "RAZORPAY_WEBHOOK_SECRET", value: process.env.RAZORPAY_WEBHOOK_SECRET, required: true },
  ];

  let hasError = false;

  for (const check of checks) {
    if (!check.value && check.required) {
      console.error(`❌ [Missing] ${check.name} is required.`);
      hasError = true;
    } else if (check.name === "RECOVER_RAZORPAY_MODE" && check.value !== "test") {
      console.error(
        `❌ [Safety Gate] RECOVER_RAZORPAY_MODE must be 'test'. Found '${check.value}'.`,
      );
      hasError = true;
    } else if (
      check.name === "RAZORPAY_KEY_ID" &&
      check.value &&
      !check.value.startsWith("rzp_test_")
    ) {
      console.error(
        `❌ [Safety Gate] RAZORPAY_KEY_ID must start with 'rzp_test_'. Found '${check.value}'.`,
      );
      hasError = true;
    } else {
      const displayVal =
        check.name.includes("KEY") || check.name.includes("SECRET") || check.name.includes("URL")
          ? check.value?.slice(0, 10) + "..."
          : check.value;
      console.log(`✓ [Configured] ${check.name}: ${displayVal}`);
    }
  }

  if (hasError) {
    console.error("\nVerification failed. Please review your .env configuration.");
    process.exit(1);
  } else {
    console.log("\n✓ All core environment assertions passed.");
  }
}

verifyEnvironment();
