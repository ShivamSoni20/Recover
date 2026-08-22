/**
 * Strict integer minor currency unit formatting and arithmetic.
 * Never use floating-point for financial calculations.
 */

export function minorToRupees(minor: number): number {
  return minor / 100;
}

export function rupeesToMinor(rupees: number): number {
  return Math.round(rupees * 100);
}

export function formatINRMinor(minor: number): string {
  const rupees = minorToRupees(minor);
  return "₹" + rupees.toLocaleString("en-IN", {
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function isValidMinorAmount(minor: number, min = 10000, max = 1000000): boolean {
  return Number.isInteger(minor) && minor >= min && minor <= max;
}
