import { keys, obj, str, strings } from "../models/validation";
import type { AgentRole } from "../records/agent-metadata";
import {
  type Action,
  type Analysis,
  TOOLS,
  validateAction,
  validateAnalysis,
} from "./actions";

export interface SubtaskResult extends Analysis {
  subtask_id: string;
  status: "completed" | "partial" | "needs_clarification" | "failed";
  diagnostic: string | null;
}
export type CollaborationAction =
  | Action
  | { kind: "delegate"; task: string; constraints: string[] }
  | { kind: "return"; result: SubtaskResult };
export type RoleAction = CollaborationAction & { report_markdown?: string };
const base = TOOLS[1].function.parameters;
export function roleTools(
  role: AgentRole,
  report: boolean,
): readonly unknown[] {
  if (role === "executor")
    return [
      TOOLS[0],
      {
        type: "function",
        function: {
          name: "return_result",
          description:
            "Return the current analysis subtask result, not the final EDA answer. Summarize meaning and evidence; omit code and debugging history.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              ...base.properties,
              findings: { ...base.properties.findings, minItems: 0 },
              methods: { ...base.properties.methods, minItems: 0 },
              subtask_id: { type: "string", minLength: 1 },
              status: {
                type: "string",
                enum: ["completed", "partial", "needs_clarification", "failed"],
              },
              diagnostic: { type: ["string", "null"], maxLength: 4096 },
            },
            required: [...base.required, "subtask_id", "status", "diagnostic"],
          },
        },
      },
    ];
  return [
    {
      type: "function",
      function: {
        name: "delegate_analysis",
        description:
          "Delegate one clearly bounded analysis question to the persistent executor.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            task: { type: "string", minLength: 1 },
            constraints: { type: "array", items: { type: "string" } },
          },
          required: ["task", "constraints"],
        },
      },
    },
    {
      type: "function",
      function: {
        ...TOOLS[1].function,
        parameters: {
          ...base,
          properties: {
            ...base.properties,
            ...(report
              ? { report_markdown: { type: "string", minLength: 1 } }
              : {}),
          },
          required: [...base.required, ...(report ? ["report_markdown"] : [])],
        },
      },
    },
  ];
}
export function validateRoleAction(
  role: AgentRole,
  name: string,
  args: string,
  evidence: ReadonlySet<string>,
  successes: number,
  codeLimit: number,
  subtaskId: string | null,
  report: boolean,
): RoleAction {
  const x = obj(JSON.parse(args));
  if (role === "planner") {
    if (subtaskId !== null)
      throw new Error("Planner cannot act during subtask");
    if (name === "delegate_analysis") {
      keys(x, ["task", "constraints"]);
      return {
        kind: "delegate",
        task: str(x.task, "task"),
        constraints: strings(x.constraints, "constraints"),
      };
    }
    if (name !== "finish_analysis")
      throw new Error("Tool not allowed for planner");
    const { report_markdown: markdown, ...analysis } = x;
    if (!report && markdown !== undefined)
      throw new Error("Report not requested");
    const action = validateAction(
      name,
      JSON.stringify(analysis),
      evidence,
      successes,
      codeLimit,
    );
    return {
      ...action,
      ...(report ? { report_markdown: str(markdown, "report_markdown") } : {}),
    };
  }
  if (!subtaskId) throw new Error("Executor requires active subtask");
  if (name === "execute_python")
    return validateAction(name, args, evidence, successes, codeLimit);
  if (name !== "return_result")
    throw new Error("Tool not allowed for executor");
  keys(x, [...base.required, "subtask_id", "status", "diagnostic"]);
  if (str(x.subtask_id, "subtask_id") !== subtaskId)
    throw new Error("Subtask identity mismatch");
  const status = x.status;
  if (
    status !== "completed" &&
    status !== "partial" &&
    status !== "needs_clarification" &&
    status !== "failed"
  )
    throw new Error("Invalid subtask status");
  const diagnostic =
    x.diagnostic === null ? null : str(x.diagnostic, "diagnostic");
  if (
    (status !== "completed" && !diagnostic) ||
    (diagnostic && diagnostic.length > 4096)
  )
    throw new Error("Diagnostic required or too large");
  return {
    kind: "return",
    result: {
      ...validateAnalysis(x, evidence, status === "completed"),
      subtask_id: subtaskId,
      status,
      diagnostic,
    },
  };
}
