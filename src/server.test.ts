import { describe, it, expect, vi, beforeEach } from "vitest";
import server from "./server";
import * as processMod from "@/lib/recovery/process-failed-payment";
import * as runnerMod from "@/lib/graph/runner";
import { supabase } from "@/lib/db/supabase";
import crypto from "crypto";

describe("Webhook Ingestion, Atomic Claim & Concurrency (server.ts)", () => {
  const secret = "test_webhook_secret_64chars_abcdef1234567890abcdef1234567890";

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
  });

  function createSignedRequest(payload: object, eventId = "evt_test_123"): Request {
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    return new Request("http://localhost:3000/api/webhooks/razorpay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": eventId,
      },
      body: rawBody,
    });
  }

  it("1. Rejects unsigned or invalid signature requests with HTTP 400", async () => {
    const req = new Request("http://localhost:3000/api/webhooks/razorpay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "payment.failed" }),
    });

    const res = await server.fetch(req, {}, {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid webhook signature");
  });

  it("2. Concurrency Race: Only one of two concurrent requests claims the event and processes domain logic", async () => {
    const processSpy = vi.spyOn(processMod, "processCanonicalFailedPayment").mockResolvedValue({
      success: true,
      caseId: "case-123",
      caseNumber: "RCV-123",
      isNew: true,
      paymentId: "pay_test_race_1",
    });

    // Simulate in-memory database atomic claim behavior
    let currentDbStatus = "RECEIVED";
    let claimCallCount = 0;

    vi.spyOn(supabase as any, "rpc").mockImplementation(async (...callArgs: any[]) => {
      if (callArgs[0] === "claim_webhook_event") {
        claimCallCount++;
        if (currentDbStatus === "RECEIVED") {
          currentDbStatus = "PROCESSING";
          return {
            data: [{ claimed: true, current_status: "PROCESSING", attempt_count: 1 }],
            error: null,
          } as any;
        } else {
          return {
            data: [{ claimed: false, current_status: currentDbStatus, attempt_count: 1 }],
            error: null,
          } as any;
        }
      }
      return { data: null, error: null } as any;
    });

    vi.spyOn(supabase as any, "from").mockReturnValue({
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    } as any);

    const payload = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_test_race_1",
            order_id: "order_test_race_1",
            status: "failed",
          },
        },
      },
    };

    const req1 = createSignedRequest(payload, "evt_race_001");
    const req2 = createSignedRequest(payload, "evt_race_001");

    // Fire both concurrently
    const [res1, res2] = await Promise.all([
      server.fetch(req1, {}, {}),
      server.fetch(req2, {}, {}),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const json1 = await res1.json();
    const json2 = await res2.json();

    // Exactly one winner and one concurrent_processing response
    const statuses = [json1.status, json2.status].sort();
    expect(statuses).toEqual(["concurrent_processing", "processed"]);

    // Exactly 1 downstream execution
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it("3. Webhook Retry: FAILED_RETRYABLE allows a subsequent retry to claim and succeed", async () => {
    let processAttempt = 0;
    const processSpy = vi
      .spyOn(processMod, "processCanonicalFailedPayment")
      .mockImplementation(async () => {
        processAttempt++;
        if (processAttempt === 1) {
          throw new Error("Downstream transient database error");
        }
        return {
          success: true,
          caseId: "case-retry-123",
          caseNumber: "RCV-RETRY",
          isNew: true,
          paymentId: "pay_retry_1",
        };
      });

    let currentDbStatus = "RECEIVED";
    const updateSpy = vi.fn().mockResolvedValue({ error: null });

    vi.spyOn(supabase as any, "rpc").mockImplementation(async (...callArgs: any[]) => {
      if (callArgs[0] === "claim_webhook_event") {
        if (currentDbStatus === "RECEIVED" || currentDbStatus === "FAILED_RETRYABLE") {
          currentDbStatus = "PROCESSING";
          return {
            data: [
              { claimed: true, current_status: "PROCESSING", attempt_count: processAttempt + 1 },
            ],
            error: null,
          } as any;
        } else {
          return {
            data: [{ claimed: false, current_status: currentDbStatus, attempt_count: 1 }],
            error: null,
          } as any;
        }
      }
      return { data: null, error: null } as any;
    });

    vi.spyOn(supabase as any, "from").mockReturnValue({
      update: vi.fn().mockImplementation((payload: any) => {
        if (payload.processing_status) {
          currentDbStatus = payload.processing_status;
        }
        return { eq: updateSpy };
      }),
    } as any);

    const payload = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_retry_1",
            order_id: "order_retry_1",
            status: "failed",
          },
        },
      },
    };

    // Attempt 1: fails downstream
    const req1 = createSignedRequest(payload, "evt_retry_001");
    const res1 = await server.fetch(req1, {}, {});
    expect(res1.status).toBe(500);
    expect(currentDbStatus).toBe("FAILED_RETRYABLE");

    // Attempt 2: Provider retries same event -> claim succeeds -> processing succeeds -> PROCESSED
    const req2 = createSignedRequest(payload, "evt_retry_001");
    const res2 = await server.fetch(req2, {}, {});
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.status).toBe("processed");
    expect(currentDbStatus).toBe("PROCESSED");

    expect(processSpy).toHaveBeenCalledTimes(2);
  });

  it("4. Success Webhook Atomic Claim: Races between payment_link.paid and payment.captured resume workflow exactly once", async () => {
    const resumeSpy = vi
      .spyOn(runnerMod, "resumeWorkflowWithPaymentEvent")
      .mockResolvedValue(undefined);

    let linkClaimed = false;

    vi.spyOn(supabase as any, "rpc").mockResolvedValue({
      data: [{ claimed: true, current_status: "PROCESSING", attempt_count: 1 }],
      error: null,
    } as any);

    vi.spyOn(supabase as any, "from").mockImplementation((...callArgs: any[]) => {
      if (callArgs[0] === "recovery_actions") {
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockImplementation(async () => {
                    if (!linkClaimed) {
                      linkClaimed = true;
                      return {
                        data: { case_id: "case-success-123", payment_link_id: "plink_123" },
                        error: null,
                      };
                    }
                    return { data: null, error: null };
                  }),
                }),
              }),
            }),
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      } as any;
    });

    const payloadLinkPaid = {
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { id: "plink_123" } },
        payment: { entity: { id: "pay_recovery_1", amount: 299900 } },
      },
    };

    const payloadPaymentCaptured = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_recovery_1",
            amount: 299900,
            notes: { payment_link_id: "plink_123" },
          },
        },
      },
    };

    const reqLink = createSignedRequest(payloadLinkPaid, "evt_succ_link");
    const reqPayment = createSignedRequest(payloadPaymentCaptured, "evt_succ_pay");

    const [res1, res2] = await Promise.all([
      server.fetch(reqLink, {}, {}),
      server.fetch(reqPayment, {}, {}),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Exactly one resume invocation
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledWith(
      "case-success-123",
      expect.objectContaining({
        kind: "RECOVERY_PAYMENT_CAPTURED",
        paymentId: "pay_recovery_1",
        paymentLinkId: "plink_123",
      }),
    );
  });
});
