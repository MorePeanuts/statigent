import * as z from "zod";
import { type ExecutionBackend, validateBackend } from "../execution/backend";
export interface ExecutionMetadata {
  version: 1;
  backend: ExecutionBackend;
  protocol_version: 1 | 2;
  files_policy: "task-workspace";
  initialization: "kernel-init-v1" | "script-init-v1";
  seed_policy: "session-start" | "each-execution";
  export_kind: "notebook" | "scripts";
}
const executionMetadataSchema = z.strictObject({
  version: z.literal(1),
  backend: z.enum(["persistent-kernel", "fresh-script"]),
  protocol_version: z.union([z.literal(1), z.literal(2)]),
  files_policy: z.literal("task-workspace"),
  initialization: z.enum(["kernel-init-v1", "script-init-v1"]),
  seed_policy: z.enum(["session-start", "each-execution"]),
  export_kind: z.enum(["notebook", "scripts"]),
});
export function executionMetadata(backend: unknown): ExecutionMetadata {
  const selected = validateBackend(backend),
    script = selected === "fresh-script";
  return {
    version: 1,
    backend: selected,
    protocol_version: script ? 2 : 1,
    files_policy: "task-workspace",
    initialization: script ? "script-init-v1" : "kernel-init-v1",
    seed_policy: script ? "each-execution" : "session-start",
    export_kind: script ? "scripts" : "notebook",
  };
}
export function validateExecutionMetadata(value: unknown): ExecutionMetadata {
  const x = executionMetadataSchema.parse(value);
  const expected = executionMetadata(x.backend);
  for (const key of Object.keys(expected) as (keyof ExecutionMetadata)[])
    if (x[key] !== expected[key])
      throw Error(`Invalid execution metadata ${key}`);
  return expected;
}
