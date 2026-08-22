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
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
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

import { verifyRazorpayWebhookSignature } from "./lib/razorpay/webhooks";
import { fetchRazorpayPayment } from "./lib/razorpay/payments";
import { supabase } from "./lib/db/supabase";
import { startRecoveryWorkflow, resumeWorkflowWithPaymentEvent } from "./lib/graph/runner";

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);

    // Dedicated raw webhook endpoint for Razorpay HMAC validation
    if (url.pathname === "/api/webhooks/razorpay" && request.method === "POST") {
      try {
        const rawBody = await request.text();
        const signature = request.headers.get("x-razorpay-signature");
        const providerEventId = request.headers.get("x-razorpay-event-id") || `evt_${Date.now()}`;

        const isValid = verifyRazorpayWebhookSignature(rawBody, signature);
        if (!isValid) {
          return new Response(JSON.stringify({ error: "Invalid webhook signature" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        const payload = JSON.parse(rawBody);
        const eventType = payload.event;

        const { error: insertError } = await supabase.from("webhook_events").insert({
          provider_event_id: providerEventId,
          event_type: eventType,
          signature_valid: true,
          raw_payload: payload,
        });

        if (insertError) {
          return new Response(JSON.stringify({ status: "already_processed" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (eventType === "payment.failed") {
          const paymentEntity = payload.payload?.payment?.entity;
          if (paymentEntity?.id) {
            const canonicalPayment = await fetchRazorpayPayment(paymentEntity.id);
            const caseId = crypto.randomUUID();
            const caseNumber = `RCV-${Math.floor(10000 + Math.random() * 89999)}`;

            await supabase.from("recovery_cases").insert({
              id: caseId,
              case_number: caseNumber,
              thread_id: caseId,
              original_order_id: canonicalPayment.order_id || "unknown",
              original_payment_id: canonicalPayment.id,
              amount_minor: canonicalPayment.amount,
              currency: canonicalPayment.currency,
              customer_email: canonicalPayment.email,
              customer_name: canonicalPayment.notes?.customer_name,
              failure_reason: canonicalPayment.error_reason || canonicalPayment.error_code || "Payment Failed",
              failure_detail: canonicalPayment.error_description || "Transaction failed at gateway",
              method: canonicalPayment.method,
              failed_at: new Date().toISOString(),
              status: "PAYMENT_FAILED",
            });

            await supabase.from("case_events").insert({
              case_id: caseId,
              event_type: "PAYMENT_FAILED_WEBHOOK_VERIFIED",
              label: "Failure received & verified",
              data: { paymentId: canonicalPayment.id, orderId: canonicalPayment.order_id },
            });

            startRecoveryWorkflow({
              caseId,
              originalOrderId: canonicalPayment.order_id || "",
              originalPaymentId: canonicalPayment.id,
            }).catch((err) => console.error("[LangGraph Workflow Error]:", err));
          }
        }

        if (eventType === "payment_link.paid" || eventType === "payment.captured") {
          const paymentEntity = payload.payload?.payment?.entity;
          const linkEntity = payload.payload?.payment_link?.entity;

          const paymentLinkId = linkEntity?.id;
          const paymentId = paymentEntity?.id;

          if (paymentLinkId) {
            const { data: action } = await supabase
              .from("recovery_actions")
              .select("case_id")
              .eq("payment_link_id", paymentLinkId)
              .maybeSingle();

            if (action?.case_id) {
              await resumeWorkflowWithPaymentEvent(action.case_id, {
                eventType,
                paymentId: paymentId || "unknown",
                amountMinor: paymentEntity?.amount || 0,
              });
            }
          }
        }

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
