export interface CapabilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function transferSessionCapabilityToCase(
  storage: CapabilityStorage,
  sessionId: string,
  caseId: string,
): boolean {
  const token = storage.getItem(`recover:capability:session:${sessionId}`);
  if (!token) return false;
  storage.setItem(`recover:capability:case:${caseId}`, token);
  return true;
}
