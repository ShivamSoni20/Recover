# Razorpay Payment Recovery Runbook

## Failure Code Mapping & Strategy Guidelines

### 1. Authentication & Customer Cancellation
- **Error Sources**: `customer`, `bank`
- **Error Steps**: `payment_authentication`, `payment_authorization`
- **Error Codes**: `BAD_REQUEST_ERROR`, `GATEWAY_ERROR`
- **Recommended Action**: `FRESH_CHECKOUT`.
- **Reasoning**: The customer either aborted 3DS authentication or made a typing mistake. Providing a direct, secure recovery payment link allows frictionless completion.

### 2. Temporary Bank Gateway Errors
- **Error Sources**: `bank`, `gateway`
- **Error Steps**: `payment_authorization`
- **Error Codes**: `GATEWAY_ERROR`, `SERVER_ERROR`
- **Recommended Action**: `FRESH_CHECKOUT` or `WAIT_FOR_CANONICAL_UPDATE`.
- **Reasoning**: If the bank's processing switch timed out, creating a fresh payment link enables payment with an alternative method (e.g. UPI instead of netbanking).

### 3. Risk & Fraud Blocked Payments
- **Error Sources**: `risk`, `internal`
- **Error Codes**: `PAYMENT_RISK_CHECK_FAILED`, `HIGH_RISK_TRANSACTION`
- **Recommended Action**: `MANUAL_REVIEW`.
- **Reasoning**: Never trigger automated checkout creation for transactions flagged for compliance, velocity limits, or fraud risk.

### 4. Independent Verification Protocol
- When `payment_link.paid` arrives, always re-fetch the payment resource directly (`GET /v1/payments/:id`).
- Verify `status === 'captured'`, `amount === expected_amount_minor`, and `currency === 'INR'`.
- Generate an immutable verification receipt before updating status to `RECOVERED_VERIFIED`.
