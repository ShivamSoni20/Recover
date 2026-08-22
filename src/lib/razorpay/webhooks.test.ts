import { describe, it, expect } from "vitest";
import { verifyRazorpayWebhookSignature } from "./webhooks";
import crypto from "crypto";

describe("Razorpay Webhook Verification", () => {
  const secret = "test_secret_123456";
  const payload = JSON.stringify({
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_test_001", amount: 299900 } } },
  });

  it("successfully validates authentic HMAC SHA-256 signature", () => {
    const validSignature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const result = verifyRazorpayWebhookSignature(payload, validSignature, secret);
    expect(result).toBe(true);
  });

  it("rejects forged or modified webhook payload", () => {
    const validSignature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const forgedPayload = JSON.stringify({
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_test_001", amount: 1000 } } },
    });
    const result = verifyRazorpayWebhookSignature(forgedPayload, validSignature, secret);
    expect(result).toBe(false);
  });

  it("returns false if signature header is missing or empty", () => {
    expect(verifyRazorpayWebhookSignature(payload, null, secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(payload, "", secret)).toBe(false);
  });
});
