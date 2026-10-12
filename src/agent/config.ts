import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_LIMITS,
  type SessionConfig,
  validateConfig,
} from "../execution/protocol";
import { integer, keys, obj, str, strings } from "../models/validation";
import { safeRelativePath } from "../records/store";
import { type ReportSpec, validateReportSpec } from "./report";
export const DEFAULT_BUDGET = {
  model_attempts: 12,
  executions: 8,
  total_tokens: 100000,
  model_timeout_ms: 90000,
  task_timeout_ms: 300000,
  rate_retries: 2,
  code_repairs: 2,
  action_corrections: 2,
  max_request_bytes: 256 * 1024,
  max_response_bytes: 2 * 1024 * 1024,
  max_trace_bytes: 16 * 1024 * 1024,
};
export type AgentBudget = typeof DEFAULT_BUDGET;
export type Organization = "single" | "planner-executor";
export function validateOrganization(value: unknown): Organization {
  if (value === undefined) return "single";
  if (value !== "single" && value !== "planner-executor")
    throw new Error("Unsupported organization");
  return value;
}
export interface AgentTask {
  organization: Organization;
  goal: string;
  constraints: string[];
  model_profile: string;
  execution: Omit<SessionConfig, "run_id" | "staging_root">;
  budget: AgentBudget;
  /** Present when the task must end with a Markdown report saved in the workspace. */
  report: ReportSpec | null;
}
export function validateTask(value: unknown): AgentTask {
  const x = obj(value);
  keys(x, [
    "goal",
    "constraints",
    "model_profile",
    "execution",
    "budget",
    "report",
    "organization",
  ]);
  const b = obj(x.budget ?? {});
  keys(b, Object.keys(DEFAULT_BUDGET));
  const budget = { ...DEFAULT_BUDGET };
  for (const key of Object.keys(b) as (keyof AgentBudget)[])
    budget[key] = integer(
      b[key],
      key,
      ["rate_retries", "code_repairs", "action_corrections"].includes(key)
        ? 0
        : 1,
    );
  const e = obj(x.execution);
  keys(e, ["image", "input_root", "inputs", "seed", "limits", "platform"]);
  const limits = {
    ...DEFAULT_LIMITS,
    ...obj(e.limits ?? {}),
    task_timeout_ms: budget.task_timeout_ms,
  };
  const config = validateConfig({
    ...e,
    run_id: "preflight",
    staging_root: "preflight",
    limits,
  });
  // An empty list is allowed (questions without data files); listed inputs must be unique.
  if (new Set(config.inputs).size !== config.inputs.length)
    throw new Error("Explicit unique input files required");
  config.inputs.forEach(safeRelativePath);
  const { run_id: _runId, staging_root: _staging, ...execution } = config;
  const organization = validateOrganization(x.organization);
  const report =
    x.report === undefined || x.report === null
      ? null
      : validateReportSpec(x.report);
  if (report && organization === "planner-executor")
    report.max_report_bytes = Math.min(
      report.max_report_bytes,
      config.limits.max_artifact_bytes,
    );
  return {
    organization,
    goal: str(x.goal, "goal"),
    constraints: strings(x.constraints ?? [], "constraints"),
    model_profile: str(x.model_profile, "model_profile"),
    execution: { ...execution, input_root: resolve(execution.input_root) },
    budget,
    report,
  };
}
export async function preflightInputs(task: AgentTask): Promise<void> {
  for (const path of task.execution.inputs) {
    let current = task.execution.input_root;
    const root = await lstat(current);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new Error("Input root must be a real directory");
    const parts = safeRelativePath(path).split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
      )
        throw new Error(
          "Input must be a regular file without symlink components",
        );
    }
  }
}
