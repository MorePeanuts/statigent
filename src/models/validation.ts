import * as z from "zod";

const nonemptyString = z.string().refine((value) => value.trim().length > 0);
const safeInteger = z.number().refine(Number.isSafeInteger);
const stringList = z.array(nonemptyString);

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
  const result = nonemptyString.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${label}`);
  return result.data;
}
export function integer(value: unknown, label: string, minimum = 1): number {
  const result = safeInteger.safeParse(value);
  if (!result.success || result.data < minimum)
    throw new Error(`Invalid ${label}`);
  return result.data;
}
export function strings(value: unknown, label: string): string[] {
  const result = stringList.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${label}`);
  return result.data;
}
