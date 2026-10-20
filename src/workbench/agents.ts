import * as z from "zod";
import {
  type AgentTask,
  DEFAULT_BUDGET,
  preflightInputs,
  validateTask,
} from "../agent/config";
import type { ExecutionBackend } from "../execution/backend";
import { type ModelProfile, selectProfile } from "../models/config";
import { InputError, validateInputName } from "./inputs";

export interface FieldIssue {
  field: string;
  message: string;
}

/** A submission the workbench refuses before allocating a run ID or calling any model. */
export class TaskError extends Error {
  readonly status = 400;
  constructor(readonly issues: FieldIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join("; "));
  }
}

export interface BuildContext {
  inputRoot: string;
  /** Parsed contents of the model configuration file. */
  models: unknown;
  images: Record<ExecutionBackend, string>;
}

export interface BuiltTask {
  agent_type: string;
  /** Exactly what the worker passes to the agent entry, which validates it again. */
  task: Record<string, unknown>;
  validated: AgentTask;
  profile: ModelProfile;
  image: string;
}

interface AgentDefinition {
  label: string;
  build(payload: unknown, context: BuildContext): Promise<BuiltTask>;
}

// Same limits as the repository's report task examples: a few small charts, a bounded report.
const REPORT_SPEC = {
  image_types: ["png", "jpeg"],
  max_images: 5,
  max_image_bytes: 2 * 1024 * 1024,
  max_report_bytes: 256 * 1024,
};

// Messages are shown next to form fields, so they are written for the (Chinese) form.
const budgetValue = z
  .number("必须是数字")
  .int("必须是整数")
  .nonnegative("不能为负数");
const budgetSchema = z
  .object(
    Object.fromEntries(
      Object.keys(DEFAULT_BUDGET).map((key) => [key, budgetValue.optional()]),
    ) as Record<keyof typeof DEFAULT_BUDGET, z.ZodOptional<typeof budgetValue>>,
  )
  .strict();

export const edaPayloadSchema = z
  .object({
    agent_type: z.literal("eda"),
    goal: z.string().trim().min(1, "请填写分析目标").max(20000, "分析目标过长"),
    constraints: z
      .array(z.string().trim().min(1).max(2000))
      .max(20)
      .default([]),
    inputs: z.array(z.string()).max(50).default([]),
    model_profile: z.string().min(1, "请选择模型"),
    organization: z.enum(["single", "planner-executor"]).default("single"),
    backend: z
      .enum(["persistent-kernel", "fresh-script"])
      .default("persistent-kernel"),
    budget: budgetSchema.default({}),
    report: z.boolean().default(false),
    seed: z.number().int().nonnegative().default(42),
  })
  .strict();
export type EdaPayload = z.input<typeof edaPayloadSchema>;

function zodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "payload",
    message: issue.message,
  }));
}

function failure(field: string, error: unknown): TaskError {
  return new TaskError([
    {
      field,
      message: error instanceof Error ? error.message : "Invalid value",
    },
  ]);
}

async function buildEda(
  value: unknown,
  context: BuildContext,
): Promise<BuiltTask> {
  const parsed = edaPayloadSchema.safeParse(value);
  if (!parsed.success) throw new TaskError(zodIssues(parsed.error));
  const payload = parsed.data;
  const inputIssues: FieldIssue[] = [];
  payload.inputs.forEach((name, index) => {
    try {
      validateInputName(name);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      inputIssues.push({ field: `inputs.${index}`, message: error.message });
    }
  });
  if (inputIssues.length) throw new TaskError(inputIssues);
  let profile: ModelProfile;
  try {
    profile = selectProfile(context.models, payload.model_profile);
  } catch (error) {
    throw failure("model_profile", error);
  }
  const image = context.images[payload.backend];
  const task = {
    goal: payload.goal,
    constraints: payload.constraints,
    model_profile: payload.model_profile,
    organization: payload.organization,
    backend: payload.backend,
    execution: {
      image,
      input_root: context.inputRoot,
      inputs: payload.inputs,
      seed: payload.seed,
    },
    budget: payload.budget,
    report: payload.report ? REPORT_SPEC : null,
  };
  // The agent's own rules decide what a valid task is; the schema above only gives the form
  // field-level messages for the common mistakes.
  let validated: AgentTask;
  try {
    validated = validateTask(task);
  } catch (error) {
    throw failure("task", error);
  }
  try {
    await preflightInputs(validated);
  } catch (error) {
    throw failure(
      "inputs",
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? new Error("Selected input file no longer exists")
        : error,
    );
  }
  return { agent_type: "eda", task, validated, profile, image };
}

// Agent types are explicit: an unknown type is refused, never treated as EDA. The modeling agent
// is expected to register here in a later change.
const AGENTS: Record<string, AgentDefinition> = {
  eda: { label: "探索性数据分析", build: buildEda },
};

export function agentTypes(): { type: string; label: string }[] {
  return Object.entries(AGENTS).map(([type, agent]) => ({
    type,
    label: agent.label,
  }));
}

export async function buildTask(
  payload: unknown,
  context: BuildContext,
): Promise<BuiltTask> {
  const type =
    payload && typeof payload === "object" && "agent_type" in payload
      ? payload.agent_type
      : undefined;
  const agent = typeof type === "string" ? AGENTS[type] : undefined;
  if (!agent)
    throw new TaskError([
      {
        field: "agent_type",
        message: `Unsupported agent type; supported: ${Object.keys(AGENTS).join(", ")}`,
      },
    ]);
  return agent.build(payload, context);
}

export function imagesFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): Record<ExecutionBackend, string> {
  return {
    "persistent-kernel":
      environment.WORKBENCH_IMAGE_PERSISTENT ?? "statigent-runtime:dev",
    "fresh-script":
      environment.WORKBENCH_IMAGE_FRESH_SCRIPT ??
      "statigent-runtime:fresh-script",
  };
}
