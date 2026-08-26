import crypto from "crypto";
import { getRazorpayConfig } from "./client";

/**
 * Verify Razorpay webhook signature against the raw body buffer/string using HMAC SHA256.
 * NEVER parse JSON before verifying the signature.
 */
export function verifyRazorpayWebhookSignature(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  secretOverride?: string,
): boolean {
  if (!signature) return false;
  const secret = secretOverride || getRazorpayConfig().webhookSecret;
  if (!secret) {
    throw new Error("[Razorpay Webhooks] RAZORPAY_WEBHOOK_SECRET is missing.");
  }

  const expectedSignature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "utf-8"),
      Buffer.from(expectedSignature, "utf-8"),
    );
  } catch {
    return false;
  }
}
