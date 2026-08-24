import { razorpayRequest } from "./client";

export interface RazorpayPaymentLinkResponse {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: string; // created, partially_paid, paid, cancelled, expired
  reference_id: string;
  description?: string;
  short_url: string;
  customer?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notify?: {
    sms: boolean;
    email: boolean;
  };
  reminder_enable?: boolean;
  notes?: Record<string, string>;
  payments?: Array<{
    payment_id: string;
    amount: number;
    status: string;
    created_at: number;
  }> | null;
  created_at: number;
}

export interface RazorpayPaymentLinkListResponse {
  entity: string;
  count: number;
  items: RazorpayPaymentLinkResponse[];
}

export async function createRecoveryPaymentLink(params: {
  amountMinor: number;
  currency?: string;
  referenceId: string;
  description: string;
  customer?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  expireByTimestamp?: number;
}): Promise<RazorpayPaymentLinkResponse> {
  return await razorpayRequest<RazorpayPaymentLinkResponse>("/payment_links", {
    method: "POST",
    body: {
      amount: params.amountMinor,
      currency: params.currency || "INR",
      reference_id: params.referenceId,
      description: params.description,
      customer: params.customer,
      notify: {
        sms: false,
        email: false,
      },
      reminder_enable: false,
      notes: params.notes,
      expire_by: params.expireByTimestamp,
    },
  });
}

export async function fetchPaymentLink(paymentLinkId: string): Promise<RazorpayPaymentLinkResponse> {
  return await razorpayRequest<RazorpayPaymentLinkResponse>(`/payment_links/${paymentLinkId}`);
}

export async function cancelPaymentLink(paymentLinkId: string): Promise<RazorpayPaymentLinkResponse> {
  return await razorpayRequest<RazorpayPaymentLinkResponse>(`/payment_links/${paymentLinkId}/cancel`, {
    method: "POST",
  });
}

export async function fetchPaymentLinks(options?: {
  referenceId?: string;
  limit?: number;
}): Promise<RazorpayPaymentLinkResponse[]> {
  const query = new URLSearchParams();
  if (options?.referenceId) query.set("reference_id", options.referenceId);
  if (options?.limit) query.set("count", options.limit.toString());
  const qs = query.toString();
  const res = await razorpayRequest<RazorpayPaymentLinkListResponse>(
    `/payment_links${qs ? `?${qs}` : ""}`
  );
  return res.items || [];
}

export async function findPaymentLinkByReferenceId(
  referenceId: string
): Promise<RazorpayPaymentLinkResponse | null> {
  try {
    const items = await fetchPaymentLinks({ referenceId, limit: 10 });
    const match = items.find((link) => link.reference_id === referenceId);
    return match || null;
  } catch {
    return null;
  }
}
