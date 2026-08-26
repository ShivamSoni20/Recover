import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

export function getRazorpayConfig() {
  const mode = process.env.RECOVER_RAZORPAY_MODE || "test";
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";

  if (mode !== "test") {
    throw new Error(
      `[Razorpay Safety Gate] RECOVER_RAZORPAY_MODE is set to '${mode}'. Production live transactions are strictly blocked in this build.`,
    );
  }

  if (keyId && !keyId.startsWith("rzp_test_")) {
    throw new Error(
      `[Razorpay Safety Gate] Invalid Test Mode key ID: ${keyId}. Key ID must start with 'rzp_test_'.`,
    );
  }

  return {
    mode,
    keyId,
    keySecret,
    webhookSecret,
  };
}

export function getAuthHeader(): string {
  const { keyId, keySecret } = getRazorpayConfig();
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing.");
  }
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

export async function razorpayRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const auth = getAuthHeader();
  const url = `https://api.razorpay.com/v1${path.startsWith("/") ? path : `/${path}`}`;

  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    let errJson: unknown;
    try {
      errJson = JSON.parse(errText);
    } catch {
      errJson = errText;
    }
    throw new Error(
      `Razorpay API Error [${res.status} ${res.statusText}] at ${path}: ${JSON.stringify(errJson)}`,
    );
  }

  return (await res.json()) as T;
}
