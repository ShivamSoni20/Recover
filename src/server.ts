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
import { resumeWorkflowWithPaymentEvent } from "./lib/graph/runner";
import { processCanonicalFailedPayment } from "./lib/recovery/process-failed-payment";

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

        const { error: insertError } = await supabase.from("webhook_events").insert({
          provider_event_id: providerEventId,
          event_type: eventType,
          signature_valid: true,
          raw_payload: payload,
        });

        if (insertError) {
          // If duplicate key violation, return 200 already_processed
          if (insertError.code === "23505" || insertError.message?.includes("duplicate")) {
            return new Response(JSON.stringify({ status: "already_processed" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          // On genuine DB failure, return 500 so Razorpay retries
          return new Response(JSON.stringify({ error: "Database error persisting webhook" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }

        // 1. payment.failed -> Canonical verification & recovery case creation
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

        // 2. payment_link.paid & payment.captured -> Recovery action fulfillment
        if (eventType === "payment_link.paid" || eventType === "payment.captured") {
          const paymentEntity = payload.payload?.payment?.entity;
          const linkEntity = payload.payload?.payment_link?.entity;

          const paymentLinkId = linkEntity?.id || paymentEntity?.notes?.payment_link_id;
          const paymentId = paymentEntity?.id;

          if (paymentLinkId) {
            const { data: action } = await supabase
              .from("recovery_actions")
              .select("case_id, accepted_success_event_id")
              .eq("payment_link_id", paymentLinkId)
              .maybeSingle();

            if (action?.case_id && !action.accepted_success_event_id) {
              await supabase
                .from("recovery_actions")
                .update({
                  accepted_success_event_id: providerEventId,
                  recovery_payment_id: paymentId,
                  updated_at: new Date().toISOString(),
                })
                .eq("payment_link_id", paymentLinkId);

              await resumeWorkflowWithPaymentEvent(action.case_id, {
                eventType,
                paymentId: paymentId || "unknown",
                amountMinor: paymentEntity?.amount || 0,
              });
            }
          }
        }

        // 3. payment_link.cancelled -> Update recovery action status
        if (eventType === "payment_link.cancelled") {
          const linkEntity = payload.payload?.payment_link?.entity;
          const paymentLinkId = linkEntity?.id;
          if (paymentLinkId) {
            await supabase
              .from("recovery_actions")
              .update({
                status: "CANCELLED",
                updated_at: new Date().toISOString(),
              })
              .eq("payment_link_id", paymentLinkId);
          }
        }

        // 4. order.paid -> Update test payment session status
        if (eventType === "order.paid") {
          const orderEntity = payload.payload?.order?.entity;
          const orderId = orderEntity?.id;
          if (orderId) {
            await supabase
              .from("test_payment_sessions")
              .update({
                status: "PAID",
                updated_at: new Date().toISOString(),
              })
              .eq("order_id", orderId);
          }
        }

        // Mark processed_at timestamp on webhook event record
        await supabase
          .from("webhook_events")
          .update({ processed_at: new Date().toISOString() })
          .eq("provider_event_id", providerEventId);

        return new Response(JSON.stringify({ status: "processed", eventType }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err: unknown) {
        console.error("[Webhook Error]:", err);
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : "Webhook error" }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
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
