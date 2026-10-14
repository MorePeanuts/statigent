import * as z from "zod";

export type ExecutionBackend = "persistent-kernel" | "fresh-script";
const backendSchema = z.enum(["persistent-kernel", "fresh-script"]);

export function validateBackend(value: unknown): ExecutionBackend {
  if (value === undefined) return "persistent-kernel";
  return backendSchema.parse(value);
}
