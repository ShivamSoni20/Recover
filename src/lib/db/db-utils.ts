export function requireDbSuccess<T>(
  res: { data: T | null; error: { message: string; code?: string; details?: string } | null },
  operationName: string,
): T {
  if (res.error || !res.data) {
    const code = res.error?.code ? `[Code: ${res.error.code}] ` : "";
    const detail = res.error?.message || "Unknown persistence error";
    console.error(`[Recover DB Error] ${operationName}: ${code}${detail}`);
    throw new Error(`Database persistence failure during '${operationName}': ${detail}`);
  }
  return res.data;
}

export function requireDbMutation(
  res: { error: { message: string; code?: string; details?: string } | null },
  operationName: string,
): void {
  if (res.error) {
    const code = res.error?.code ? `[Code: ${res.error.code}] ` : "";
    const detail = res.error?.message || "Unknown persistence error";
    console.error(`[Recover DB Error] ${operationName}: ${code}${detail}`);
    throw new Error(`Database mutation failure during '${operationName}': ${detail}`);
  }
}
