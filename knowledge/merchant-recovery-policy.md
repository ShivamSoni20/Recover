# Merchant Recovery Policy

## Overview
This document specifies the operational and financial policies governing automated payment recovery for failed transactions processed via Razorpay.

## Key Rules & Constraints
1. **Idempotency & Late Capture**:
   - A recovery checkout must never be created if the original order or payment has already been captured or marked as paid.
   - If a payment succeeds after initial failure (late capture), any active recovery checkout must be immediately cancelled.

2. **Maximum Recovery Attempts**:
   - At most 2 recovery attempts may be made per failed transaction.
   - If attempt count >= 2, the case must be escalated to manual review.

3. **Amount Boundaries**:
   - The recovery checkout amount must strictly equal the exact unpaid balance in minor units (paise).
   - In Test Mode, the maximum allowable amount is ₹10,000 (1,000,000 paise).
   - Currency must match the original order currency (INR).

4. **Eligible Failure Classes**:
   - `CUSTOMER_CORRECTABLE` (e.g. incorrect OTP, invalid card details, authentication cancelled) -> Eligible for `FRESH_CHECKOUT`.
   - `BANK_DECLINE` (temporary bank downtime) -> Eligible for `FRESH_CHECKOUT` or `WAIT_FOR_CANONICAL_UPDATE`.
   - `INSUFFICIENT_FUNDS` -> Eligible for `FRESH_CHECKOUT` after user notification.
   - `RISK_OR_POLICY` -> Strictly BLOCKED from automated recovery. Must route to `MANUAL_REVIEW`.
   - `UNKNOWN` -> Blocked if confidence is below 70%.
