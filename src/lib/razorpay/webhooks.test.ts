import { describe, it, expect } from "vitest";
import { verifyRazorpayWebhookSignature } from "./webhooks";
import crypto from "crypto";

describe("Razorpay Webhook Verification & HMAC SHA-256 Tests", () => {
  const secret = "fb6bfb3d6bb7b3e8907c02a1cc5d63d23bcf9e0a62cdbe40184e1a4ef820773d";
  const payload = JSON.stringify({
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: "pay_signature_test",
          amount: 299900,
          currency: "INR",
          status: "failed",
        },
      },
    },
  });

  it("PASS: correctly validates authentic HMAC SHA-256 signature with matching secret", () => {
    const validSignature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const result = verifyRazorpayWebhookSignature(payload, validSignature, secret);
    expect(result).toBe(true);
  });

  it("FAIL: rejects modified or tampered webhook payload with original signature", () => {
    const validSignature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const modifiedPayload = JSON.stringify({
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_signature_test",
            amount: 1000, // Modified amount
            currency: "INR",
            status: "failed",
          },
        },
      },
    });
    const result = verifyRazorpayWebhookSignature(modifiedPayload, validSignature, secret);
    expect(result).toBe(false);
  });

  it("FAIL: returns false if signature header is missing or null or undefined", () => {
    expect(verifyRazorpayWebhookSignature(payload, null, secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(payload, undefined, secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(payload, "", secret)).toBe(false);
  });

  it("FAIL: rejects when signature was generated using a different secret", () => {
    const wrongSecret = "wrong_secret_1234567890abcdef";
    const validSignatureForWrongSecret = crypto
      .createHmac("sha256", wrongSecret)
      .update(payload)
      .digest("hex");
    const result = verifyRazorpayWebhookSignature(payload, validSignatureForWrongSecret, secret);
    expect(result).toBe(false);
  });

  it("FAIL: rejects malformed, partial, or non-hex signatures without throwing timing errors", () => {
    expect(verifyRazorpayWebhookSignature(payload, "short_invalid_sig", secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(payload, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", secret)).toBe(false);
  });
});
