import { type ExecutionBackend, validateBackend } from "../execution/backend";
import { keys, obj, str } from "../models/validation";
export interface ExecutionMetadata {
  version: 1;
  backend: ExecutionBackend;
  protocol_version: 1 | 2;
  files_policy: "task-workspace";
  initialization: "kernel-init-v1" | "script-init-v1";
  seed_policy: "session-start" | "each-execution";
  export_kind: "notebook" | "scripts";
}
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
  const x = obj(value);
  keys(x, [
    "version",
    "backend",
    "protocol_version",
    "files_policy",
    "initialization",
    "seed_policy",
    "export_kind",
  ]);
  const expected = executionMetadata(str(x.backend, "backend"));
  for (const [key, v] of Object.entries(expected))
    if (x[key] !== v) throw Error(`Invalid execution metadata ${key}`);
  return expected;
}
