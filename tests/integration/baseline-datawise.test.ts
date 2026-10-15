import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineExecution } from "../../src/baselines/execution";
import { baselineModel } from "../../src/baselines/model";
import { runTrustedWorker, workerViewSchema } from "../../src/baselines/worker";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";
import { reply, ScriptClient } from "../helpers/agent";

test("official Datawise FST and Docker preserve rollback, filtering, artifacts and shared accounting", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "datawise-docker-")),
  );
  await mkdir(join(root, "input"));
  const execution = await baselineExecution({
    config: {
      run_id: "datawise-docker",
      image: "statigent-runtime:baselines-cpu-v1",
      backend: "persistent-kernel",
      input_root: join(root, "input"),
      inputs: [],
      staging_root: join(root, "stage"),
      seed: 7,
      limits: { ...DEFAULT_LIMITS, task_timeout_ms: 60000 },
    },
    artifactDirectory: join(root, "artifacts"),
    event: async () => {},
    allowKnownReplay: true,
  });
  const replies = [
    "```markdown\n[STEP GOAL] Original plan.\n```\n```python\nx = 10\n```",
    "```python\nprint(x)\n```\n<end_step>",
    "```markdown\n[STEP GOAL] Revised plan.\n```\n```python\nx = 40\n```\n<Iterate on Current STEP>",
    '```python\nraise ValueError("fix me")\n```\n<end_step>',
    '```python\nfrom pathlib import Path\nPath("report.md").write_text(str(x + 2))\n```\n<end_debug>',
    '```python\nfrom pathlib import Path\nPath("report.md").write_text(str(x + 2))\n```\n<debug_success>',
    '```markdown\nSTATIGENT_FINAL\n{"kind":"report","path":"report.md"}\n```\n<Fulfill USER INSTRUCTION>',
  ];
  const controller = new AbortController();
  const model = baselineModel({
    client: new ScriptClient((_body, index) =>
      reply([], {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              reasoning_content: `reason-${index}`,
              content: replies[index] ?? "Unexpected call",
            },
          },
        ],
      }),
    ),
    signal: controller.signal,
    budget: { model_attempts: 8, total_tokens: 150000, timeout_ms: 60000 },
    event: async () => {},
  });
  const stages: string[] = [],
    reasons: string[] = [],
    errors: string[] = [];
  let delivered = "";
  try {
    await runTrustedWorker({
      directory: join(root, "worker"),
      timeout_ms: 60000,
      signal: controller.signal,
      view: workerViewSchema.parse({
        protocol_version: 1,
        run_id: "datawise-docker",
        method: "datawiseagent",
        goal: "Produce report.md with 42",
        constraints: [],
        files: [],
        output: {
          kind: "report",
          instructions: "Explicit report",
          report_file: "report.md",
          image_types: ["png"],
          max_images: 4,
          max_image_bytes: 65536,
          max_report_bytes: 65536,
        },
        seed: 7,
        options: {
          schema_version: 1,
          method: "datawiseagent",
          image: "statigent-runtime:baselines-cpu-v1",
        },
      }),
      recorder: {
        event: async (type, details) => {
          if (type === "worker_stderr") errors.push(String(details.text));
        },
      },
      stopExecution: () => execution.close(),
      handle: async (request, signal) => {
        if (request.type === "workspace.status")
          return { inputs: [], artifacts: execution.artifacts.list() };
        if (request.type === "model.request") {
          stages.push(request.stage);
          return { ...(await model.request(request.messages, request.stage)) };
        }
        if (request.type === "execution.execute")
          return {
            ...(await execution.execute(
              request.code,
              request.request_id,
              signal,
            )),
          };
        if (request.type === "execution.restart") {
          reasons.push(request.reason);
          return execution.restart(request.reason, signal);
        }
        if (request.type === "notebook.record") return { accepted: true };
        if (
          request.type === "submission.finish" &&
          request.submission.kind === "report"
        ) {
          delivered = (
            await execution.artifacts.read(request.submission.path)
          ).toString();
          return { accepted: true };
        }
        throw new Error("Unexpected request");
      },
    });
    expect(stages).toEqual([
      "initiate",
      "execution",
      "planning",
      "execution",
      "debug",
      "post_filter",
      "planning",
    ]);
    expect(reasons).toEqual(["plan-rollback", "post-filter"]);
    expect(delivered).toBe("42");
    expect(model.usage()).toMatchObject({ attempts: 7, total_tokens: 105 });
    expect(execution.usage().executions).toBeGreaterThan(6);
    expect(execution.usage().kernel_epoch).toBe(3);
    expect(execution.session.closeResult?.cleanup_error).toBeUndefined();
  } catch (error) {
    throw new Error(`${error}\n${errors.join("").slice(-9000)}`);
  } finally {
    await execution.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
