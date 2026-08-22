import { razorpayRequest } from "./client";

export interface RazorpayOrderResponse {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt?: string;
  status: string;
  attempts: number;
  notes?: Record<string, string>;
  created_at: number;
}

export async function createRazorpayOrder(params: {
  amountMinor: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrderResponse> {
  return await razorpayRequest<RazorpayOrderResponse>("/orders", {
    method: "POST",
    body: {
      amount: params.amountMinor,
      currency: params.currency || "INR",
      receipt: params.receipt,
      notes: params.notes,
    },
  });
}

export async function fetchRazorpayOrder(orderId: string): Promise<RazorpayOrderResponse> {
  return await razorpayRequest<RazorpayOrderResponse>(`/orders/${orderId}`);
}
