export type ExecutionBackend = "persistent-kernel" | "fresh-script";

export function validateBackend(value: unknown): ExecutionBackend {
  if (value === undefined) return "persistent-kernel";
  if (value !== "persistent-kernel" && value !== "fresh-script")
    throw new Error("Unsupported execution backend");
  return value;
}
