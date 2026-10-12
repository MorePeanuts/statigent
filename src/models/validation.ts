export function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unsupported field: ${key}`);
}
export function str(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${label}`);
  return value;
}
export function integer(value: unknown, label: string, minimum = 1): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value.map((item) => str(item, label));
}
