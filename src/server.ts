import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} - try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

import nodeCrypto from "node:crypto";
import { verifyRazorpayWebhookSignature } from "./lib/razorpay/webhooks";
import { supabase } from "./lib/db/supabase";
import {
  resumeWorkflowWithPaymentEvent,
  ensureRecoveryPaymentEventApplied,
} from "./lib/graph/runner";
import { processCanonicalFailedPayment } from "./lib/recovery/process-failed-payment";
import { requireDbMutation } from "./lib/db/db-utils";

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);

    // Dedicated raw webhook endpoint for Razorpay HMAC validation
    if (url.pathname === "/api/webhooks/razorpay" && request.method === "POST") {
      try {
        const rawBody = await request.text();
        const signature = request.headers.get("x-razorpay-signature");
        let providerEventId = request.headers.get("x-razorpay-event-id");

        const isValid = verifyRazorpayWebhookSignature(rawBody, signature);
        if (!isValid) {
          return new Response(JSON.stringify({ error: "Invalid webhook signature" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        const payload = JSON.parse(rawBody);
        const eventType = payload.event;

        // Cryptographic fallback identity if event header is missing
        if (!providerEventId) {
          providerEventId = `evt_${nodeCrypto.createHash("sha256").update(`${eventType}_${rawBody}`).digest("hex").slice(0, 24)}`;
        }

        // 1. Atomic claim of event for processing (Allowed states: RECEIVED, FAILED_RETRYABLE, or stale PROCESSING lease)
        let claimed = false;
        let currentStatus = "RECEIVED";

        try {
          const { data: claimData, error: rpcError } = await supabase.rpc("claim_webhook_event", {
            p_provider_event_id: providerEventId,
            p_event_type: eventType,
            p_raw_payload: payload,
          });

          if (rpcError) {
            console.error("[Webhook Claim RPC Error]:", rpcError);
            return new Response(JSON.stringify({ error: "Webhook processing unavailable" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }

          if (Array.isArray(claimData) && claimData.length > 0) {
            claimed = claimData[0].claimed;
            currentStatus = claimData[0].current_status;
          } else {
            return new Response(JSON.stringify({ error: "Webhook processing unavailable" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
        } catch (claimEx) {
          console.error("[Webhook Claim Exception]:", claimEx);
          return new Response(JSON.stringify({ error: "Webhook processing unavailable" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }

        if (!claimed) {
          if (currentStatus === "PROCESSED") {
            return new Response(JSON.stringify({ status: "already_processed", eventType }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (currentStatus === "PROCESSING") {
            return new Response(JSON.stringify({ status: "concurrent_processing", eventType }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ error: "Webhook processing unavailable" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }

        try {
          // 2. Process according to event type
          if (eventType === "payment.failed") {
            const paymentEntity = payload.payload?.payment?.entity;
            if (paymentEntity?.id) {
              await processCanonicalFailedPayment({
                paymentId: paymentEntity.id,
                orderId: paymentEntity.order_id,
                provenance: "WEBHOOK",
              });
            }
          }

          if (eventType === "payment_link.paid" || eventType === "payment.captured") {
            const paymentEntity = payload.payload?.payment?.entity;
            const linkEntity = payload.payload?.payment_link?.entity;

            const paymentLinkId = linkEntity?.id || paymentEntity?.notes?.payment_link_id;
            const paymentId = paymentEntity?.id;

            if (paymentLinkId) {
              // P0-6: Separate provider event acceptance from retryable workflow application
              const { data: actionRow } = await supabase
                .from("recovery_actions")
                .select("id, case_id, accepted_success_event_id, recovery_payment_id, status")
                .eq("payment_link_id", paymentLinkId)
                .maybeSingle();

              if (actionRow?.case_id) {
                if (!actionRow.accepted_success_event_id) {
                  const updateRes = await supabase
                    .from("recovery_actions")
                    .update({
                      accepted_success_event_id: providerEventId,
                      recovery_payment_id: paymentId,
                      status: "PAID",
                      updated_at: new Date().toISOString(),
                    })
                    .eq("id", actionRow.id);
                  requireDbMutation(
                    updateRes,
                    "update recovery_actions to PAID on success webhook",
                  );
                }

                await ensureRecoveryPaymentEventApplied({
                  caseId: actionRow.case_id,
                  paymentLinkId,
                  paymentId: paymentId || "unknown",
                  amountMinor: paymentEntity?.amount || 0,
                  providerEventId,
                  eventType,
                });
              }
            } else if (eventType === "payment.captured" && paymentId) {
              // Check if original payment was captured late
              const { data: originalCase } = await supabase
                .from("recovery_cases")
                .select("id, status, terminal_status")
                .eq("original_payment_id", paymentId)
                .maybeSingle();

              if (
                originalCase &&
                !["RECOVERED_VERIFIED", "STOPPED_ALREADY_PAID"].includes(
                  originalCase.terminal_status || "",
                )
              ) {
                await resumeWorkflowWithPaymentEvent(originalCase.id, {
                  kind: "ORIGINAL_PAYMENT_CAPTURED",
                  eventType,
                  paymentId,
                  providerEventId,
                });
              }
            }
          }

          if (eventType === "payment_link.cancelled") {
            const linkEntity = payload.payload?.payment_link?.entity;
            const paymentLinkId = linkEntity?.id;
            if (paymentLinkId) {
              const cancelRes = await supabase
                .from("recovery_actions")
                .update({
                  status: "CANCELLED",
                  updated_at: new Date().toISOString(),
                })
                .eq("payment_link_id", paymentLinkId);
              requireDbMutation(cancelRes, "update recovery_actions to CANCELLED");
            }
          }

          if (eventType === "order.paid") {
            const orderEntity = payload.payload?.order?.entity;
            const orderId = orderEntity?.id;
            if (orderId) {
              const orderUpdateRes = await supabase
                .from("test_payment_sessions")
                .update({
                  status: "PAID",
                  updated_at: new Date().toISOString(),
                })
                .eq("order_id", orderId);
              requireDbMutation(orderUpdateRes, "update test_payment_sessions to PAID");
            }
          }

          // 3. Mark PROCESSED on successful completion - P0-5: verify write
          const { error: markError } = await supabase
            .from("webhook_events")
            .update({
              processing_status: "PROCESSED",
              processed_at: new Date().toISOString(),
              last_error: null,
            })
            .eq("provider_event_id", providerEventId);

          if (markError) {
            console.error(
              `[Webhook Ingestion] Failed to mark event ${providerEventId} as PROCESSED:`,
              markError,
            );
            return new Response(JSON.stringify({ error: "Failed to mark webhook as processed" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }

          return new Response(JSON.stringify({ status: "processed", eventType }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (procErr: unknown) {
          console.error(`[Webhook Processing Failure for event ${providerEventId}]:`, procErr);
          await supabase
            .from("webhook_events")
            .update({
              processing_status: "FAILED_RETRYABLE",
              last_error: procErr instanceof Error ? procErr.message : "Processing error",
            })
            .eq("provider_event_id", providerEventId);

          return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      } catch (err: unknown) {
        console.error("[Webhook Outer Error]:", err);
        return new Response(JSON.stringify({ error: "Webhook error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
