import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET } from "../../src/agent/config";
import {
  agentTypes,
  type BuildContext,
  buildTask,
  imagesFromEnvironment,
  TaskError,
} from "../../src/workbench/agents";

const MODELS = [
  {
    id: "alpha",
    provider: "deepseek",
    protocol: "chat-completions",
    base_url: "https://api.example.invalid",
    model: "alpha-model",
    display_name: "Alpha",
    api_key_env: "ALPHA_KEY",
    capabilities: { tool_calls: true, thinking: true },
    generation: { thinking: "enabled", max_output_tokens: 4096 },
  },
];

async function context(): Promise<BuildContext> {
  const base = await mkdtemp(join(tmpdir(), "workbench-agents-"));
  const inputRoot = join(base, "inputs");
  await mkdir(inputRoot);
  await writeFile(join(inputRoot, "synthetic.csv"), "group,value\nA,1\n");
  await writeFile(join(base, "outside.csv"), "secret\n");
  await symlink(join(base, "outside.csv"), join(inputRoot, "linked.csv"));
  return {
    inputRoot,
    models: MODELS,
    images: imagesFromEnvironment({}),
  };
}

const valid = {
  agent_type: "eda",
  goal: "  Compare group means  ",
  inputs: ["synthetic.csv"],
  model_profile: "alpha",
};

async function issues(payload: unknown, ctx?: BuildContext) {
  try {
    await buildTask(payload, ctx ?? (await context()));
  } catch (error) {
    if (error instanceof TaskError) return error.issues;
    throw error;
  }
  throw new Error("Expected a TaskError");
}

test("a minimal EDA submission becomes a task the agent entry accepts", async () => {
  const ctx = await context();
  const built = await buildTask(valid, ctx);
  expect(built.agent_type).toBe("eda");
  expect(built.image).toBe("statigent-runtime:dev");
  expect(built.profile.id).toBe("alpha");
  expect(built.task).toEqual({
    goal: "Compare group means",
    constraints: [],
    model_profile: "alpha",
    organization: "single",
    backend: "persistent-kernel",
    execution: {
      image: "statigent-runtime:dev",
      input_root: ctx.inputRoot,
      inputs: ["synthetic.csv"],
      seed: 42,
    },
    budget: {},
    report: null,
  });
  // Budget items left blank fall back to the agent's defaults.
  expect(built.validated.budget).toEqual(DEFAULT_BUDGET);
});

test("organization, backend, budget overrides and report are passed through", async () => {
  const built = await buildTask(
    {
      ...valid,
      organization: "planner-executor",
      backend: "fresh-script",
      budget: { model_attempts: 20, total_tokens: 400000 },
      report: true,
      constraints: ["Use only the provided input."],
    },
    await context(),
  );
  expect(built.image).toBe("statigent-runtime:fresh-script");
  expect(built.validated.organization).toBe("planner-executor");
  expect(built.validated.backend).toBe("fresh-script");
  expect(built.validated.budget.model_attempts).toBe(20);
  expect(built.validated.budget.executions).toBe(DEFAULT_BUDGET.executions);
  expect(built.validated.report?.max_images).toBe(5);
});

test("form mistakes are reported per field before any run exists", async () => {
  expect(await issues({ ...valid, goal: "   " })).toEqual([
    { field: "goal", message: "Goal is required" },
  ]);
  expect(
    (await issues({ ...valid, budget: { executions: -1 } })).map(
      (i) => i.field,
    ),
  ).toEqual(["budget.executions"]);
  expect(
    (await issues({ ...valid, budget: { model_attempts: 1.5 } })).map(
      (i) => i.field,
    ),
  ).toEqual(["budget.model_attempts"]);
  expect(
    (await issues({ ...valid, budget: { unknown_limit: 3 } }))[0]?.field,
  ).toBe("budget");
  expect((await issues({ ...valid, organization: "swarm" }))[0]?.field).toBe(
    "organization",
  );
  expect((await issues({ ...valid, extra: true }))[0]?.field).toBe("payload");
});

test("the agent's own rules still apply after the form schema", async () => {
  // Zero passes the form schema but the agent requires at least one model attempt.
  expect(await issues({ ...valid, budget: { model_attempts: 0 } })).toEqual([
    { field: "task", message: expect.stringContaining("model_attempts") },
  ]);
  expect(
    (await issues({ ...valid, inputs: ["synthetic.csv", "synthetic.csv"] }))[0]
      ?.field,
  ).toBe("task");
});

test("unknown profiles are refused", async () => {
  expect(await issues({ ...valid, model_profile: "missing" })).toEqual([
    { field: "model_profile", message: "Unknown model profile: missing" },
  ]);
});

test("inputs must be existing regular files inside the input area", async () => {
  expect((await issues({ ...valid, inputs: ["../outside.csv"] }))[0]).toEqual(
    expect.objectContaining({ field: "inputs.0" }),
  );
  expect((await issues({ ...valid, inputs: ["/etc/passwd"] }))[0]?.field).toBe(
    "inputs.0",
  );
  expect(await issues({ ...valid, inputs: ["linked.csv"] })).toEqual([
    {
      field: "inputs",
      message: "Input must be a regular file without symlink components",
    },
  ]);
  expect(await issues({ ...valid, inputs: ["gone.csv"] })).toEqual([
    { field: "inputs", message: "Selected input file no longer exists" },
  ]);
});

test("unregistered agent types are refused rather than treated as EDA", async () => {
  for (const agent_type of ["modeling", undefined, 3])
    expect(await issues({ ...valid, agent_type })).toEqual([
      {
        field: "agent_type",
        message: "Unsupported agent type; supported: eda",
      },
    ]);
  expect(agentTypes()).toEqual([{ type: "eda", label: "探索性数据分析" }]);
});

test("images can be overridden from the environment", () => {
  expect(
    imagesFromEnvironment({
      WORKBENCH_IMAGE_PERSISTENT: "custom:kernel",
      WORKBENCH_IMAGE_FRESH_SCRIPT: "custom:script",
    }),
  ).toEqual({
    "persistent-kernel": "custom:kernel",
    "fresh-script": "custom:script",
  });
});
