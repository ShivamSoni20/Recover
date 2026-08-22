import { razorpayRequest } from "./client";

export interface RazorpayPaymentResponse {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string; // created, authorized, captured, refunded, failed
  order_id: string | null;
  invoice_id: string | null;
  international: boolean;
  method: string;
  amount_refunded: number;
  refund_status: string | null;
  captured: boolean;
  description?: string;
  card_id?: string;
  bank?: string;
  wallet?: string;
  vpa?: string;
  email?: string;
  contact?: string;
  notes?: Record<string, string>;
  fee?: number;
  tax?: number;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  created_at: number;
}

export interface RazorpayPaymentListResponse {
  entity: string;
  count: number;
  items: RazorpayPaymentResponse[];
}

export async function fetchRazorpayPayment(paymentId: string): Promise<RazorpayPaymentResponse> {
  return await razorpayRequest<RazorpayPaymentResponse>(`/payments/${paymentId}`);
}

export async function fetchPaymentsForOrder(orderId: string): Promise<RazorpayPaymentResponse[]> {
  const res = await razorpayRequest<RazorpayPaymentListResponse>(`/orders/${orderId}/payments`);
  return res.items || [];
}
