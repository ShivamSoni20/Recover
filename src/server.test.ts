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

    vi.spyOn(supabase as any, "rpc").mockImplementation(async (...callArgs: any[]) => {
      if (callArgs[0] === "claim_webhook_event") {
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

    const [res1, res2] = await Promise.all([
      server.fetch(req1, {}, {}),
      server.fetch(req2, {}, {}),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const json1 = await res1.json();
    const json2 = await res2.json();

    const statuses = [json1.status, json2.status].sort();
    expect(statuses).toEqual(["concurrent_processing", "processed"]);
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

    const req1 = createSignedRequest(payload, "evt_retry_001");
    const res1 = await server.fetch(req1, {}, {});
    expect(res1.status).toBe(500);
    expect(currentDbStatus).toBe("FAILED_RETRYABLE");

    const req2 = createSignedRequest(payload, "evt_retry_001");
    const res2 = await server.fetch(req2, {}, {});
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.status).toBe("processed");
    expect(currentDbStatus).toBe("PROCESSED");

    expect(processSpy).toHaveBeenCalledTimes(2);
  });

  it("4. Stale Webhook Lease: Stale PROCESSING event (>2 min) can be reclaimed by retry", async () => {
    const processSpy = vi.spyOn(processMod, "processCanonicalFailedPayment").mockResolvedValue({
      success: true,
      caseId: "case-stale-1",
      caseNumber: "RCV-STALE",
      isNew: true,
      paymentId: "pay_stale_1",
    });

    // Simulate stale lease reclaim in RPC
    let attempt = 1;
    vi.spyOn(supabase as any, "rpc").mockImplementation(async (...callArgs: any[]) => {
      if (callArgs[0] === "claim_webhook_event") {
        attempt++;
        return {
          data: [{ claimed: true, current_status: "PROCESSING", attempt_count: attempt }],
          error: null,
        } as any;
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
            id: "pay_stale_1",
            order_id: "order_stale_1",
            status: "failed",
          },
        },
      },
    };

    const req = createSignedRequest(payload, "evt_stale_lease");
    const res = await server.fetch(req, {}, {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("processed");
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it("5. Claim DB Outage: Database error claiming event returns HTTP 500 (never false 200)", async () => {
    vi.spyOn(supabase as any, "rpc").mockResolvedValue({
      data: null,
      error: { message: "Database connection timeout", code: "57P01" },
    } as any);

    const payload = {
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_db_err", order_id: "order_db_err" } } },
    };

    const req = createSignedRequest(payload, "evt_db_error");
    const res = await server.fetch(req, {}, {});
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Webhook processing unavailable");
  });

  it("6. Final PROCESSED Write Failure: If marking PROCESSED fails, returns HTTP 500", async () => {
    vi.spyOn(processMod, "processCanonicalFailedPayment").mockResolvedValue({
      success: true,
      caseId: "case-proc-fail",
      caseNumber: "RCV-PROCF",
      isNew: true,
      paymentId: "pay_proc_1",
    });

    vi.spyOn(supabase as any, "rpc").mockResolvedValue({
      data: [{ claimed: true, current_status: "PROCESSING", attempt_count: 1 }],
      error: null,
    } as any);

    // Fail the final status update
    vi.spyOn(supabase as any, "from").mockImplementation((...callArgs: any[]) => {
      if (callArgs[0] === "webhook_events") {
        return {
          update: vi.fn().mockReturnValue({
            eq: vi
              .fn()
              .mockResolvedValue({ error: { message: "Lock wait timeout", code: "55P03" } }),
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      } as any;
    });

    const payload = {
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_proc_1", order_id: "order_proc_1" } } },
    };

    const req = createSignedRequest(payload, "evt_proc_fail");
    const res = await server.fetch(req, {}, {});
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Failed to mark webhook as processed");
  });

  it("7. Recovery Success Event: Resumes graph and marks event applied retryably", async () => {
    const resumeSpy = vi
      .spyOn(runnerMod, "ensureRecoveryPaymentEventApplied")
      .mockResolvedValue(undefined);

    vi.spyOn(supabase as any, "rpc").mockResolvedValue({
      data: [{ claimed: true, current_status: "PROCESSING", attempt_count: 1 }],
      error: null,
    } as any);

    vi.spyOn(supabase as any, "from").mockImplementation((...callArgs: any[]) => {
      if (callArgs[0] === "recovery_actions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: "act_123",
                  case_id: "case-success-123",
                  payment_link_id: "plink_123",
                  accepted_success_event_id: null,
                },
                error: null,
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        } as any;
      }
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      } as any;
    });

    const payload = {
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { id: "plink_123" } },
        payment: { entity: { id: "pay_recovery_1", amount: 299900 } },
      },
    };

    const req = createSignedRequest(payload, "evt_succ_retryable");
    const res = await server.fetch(req, {}, {});
    expect(res.status).toBe(200);

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: "case-success-123",
        paymentLinkId: "plink_123",
        paymentId: "pay_recovery_1",
      }),
    );
  });
});
