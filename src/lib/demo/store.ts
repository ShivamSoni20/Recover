import { useCallback, useSyncExternalStore } from "react";
import {
  canTransition,
  type DemoCase,
  type DemoEvent,
  type DemoState,
  type DemoStore,
} from "./types";

export const STORAGE_KEY = "recover_demo_state";
export const DEMO_AMOUNT_MINOR = 299900;

const EMPTY_STORE: DemoStore = { cases: [], activeCaseId: null };

let store: DemoStore = EMPTY_STORE;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoStore;
      if (parsed && Array.isArray(parsed.cases)) store = parsed;
    }
  } catch {
    /* ignore */
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  hydrate();
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return store;
}

function getServerSnapshot() {
  return EMPTY_STORE;
}

export function useDemoStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useDemoCase(caseId?: string) {
  const s = useDemoStore();
  const id = caseId ?? s.activeCaseId;
  return s.cases.find((c) => c.caseId === id) ?? null;
}

export function useDemoActions() {
  return {
    createCase: useCallback(createCase, []),
    updateCase: useCallback(updateCase, []),
    resetDemo: useCallback(resetDemo, []),
  };
}

function setStore(next: DemoStore) {
  store = next;
  persist();
  emit();
}

const pad = (n: number) => String(n).padStart(2, "0");
export function nowClock() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function seq() {
  return String(Math.floor(10000 + Math.random() * 89999));
}

/** Fresh hex token per demo run, e.g. A82F31. */
function hex(len = 6) {
  let out = "";
  for (let i = 0; i < len; i++) out += "0123456789ABCDEF"[Math.floor(Math.random() * 16)];
  return out;
}

export function createCase(input: {
  description: string;
  customer: { name: string; email: string; purpose: string };
  amountMinor: number;
}): DemoCase {
  const n = seq();
  const h = hex();
  const demoCase: DemoCase = {
    caseId: `RCV-${n}`,
    orderId: `order_demo_${h}`,
    originalPaymentId: `pay_demo_${hex()}`,
    amountMinor: input.amountMinor,
    currency: "INR",
    paymentStatus: "CREATED",
    failureReason: "BANK / PAYMENT FAILURE",
    failureDetail: "The bank declined the transaction.",
    method: "UPI",
    failedAt: null,
    failureClass: "CUSTOMER_CORRECTABLE",
    confidence: 92,
    diagnosis:
      "The payment did not complete. No successful payment exists and the failure appears safe to retry through a fresh checkout.",
    recoveryStrategy: "FRESH CHECKOUT",
    gateChecks: [],
    recoveryReference: `rcv_demo_${hex()}`,
    recoveryLinkId: `plink_demo_${hex()}`,
    recoveryPaymentId: `pay_demo_${hex()}`,
    verificationChecks: [],
    state: "ORDER_CREATED",
    events: [{ time: nowClock(), label: "Order created" }],
    customer: input.customer,
    description: input.description,
  };
  setStore({ cases: [demoCase, ...store.cases], activeCaseId: demoCase.caseId });
  return demoCase;
}

export function updateCase(
  caseId: string,
  patch: Partial<DemoCase> & { state?: DemoState },
  event?: DemoEvent | string,
) {
  const existing = store.cases.find((c) => c.caseId === caseId);
  if (!existing) return;
  if (patch.state && !canTransition(existing.state, patch.state)) {
    // Illegal transition — ignore to keep the state machine honest.
    delete patch.state;
  }
  const events = event
    ? [
        ...existing.events,
        typeof event === "string" ? { time: nowClock(), label: event } : event,
      ]
    : existing.events;
  const next = { ...existing, ...patch, events };
  setStore({
    ...store,
    cases: store.cases.map((c) => (c.caseId === caseId ? next : c)),
  });
}

export function resetDemo() {
  setStore(EMPTY_STORE);
}
