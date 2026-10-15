import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineAdapter } from "../../src/baselines/adapter";
import { validateTask } from "../../src/evaluation/contracts";
import { profile, reply, ScriptClient } from "../helpers/agent";

for (const method of ["react", "autogen", "datawiseagent"] as const)
  for (const mode of ["missing-report", "cancel", "timeout"] as const) {
    test(`${method} ${mode} never fabricates delivery or resumes unknown execution`, async () => {
      const root = await realpath(
          await mkdtemp(join(tmpdir(), "baseline-failure-")),
        ),
        controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await mkdir(join(root, "input"));
        await mkdir(join(root, "output"));
        const code = "import time\ntime.sleep(15)",
          done = { kind: "report", path: "report.md" };
        const responses =
          method === "react"
            ? [
                JSON.stringify(
                  mode === "missing-report"
                    ? { action: "finish", submission: done }
                    : { action: "execute", code },
                ),
              ]
            : method === "autogen"
              ? [
                  mode === "missing-report"
                    ? `STATIGENT_FINAL\n${JSON.stringify(done)}`
                    : `\`\`\`python\n${code}\n\`\`\``,
                ]
              : [
                  "```markdown\n[STEP GOAL] Report\n```",
                  mode === "missing-report"
                    ? `\`\`\`markdown\nSTATIGENT_FINAL\n${JSON.stringify(done)}\n\`\`\`\n<Fulfill USER INSTRUCTION>`
                    : `\`\`\`python\n${code}\n\`\`\`\n<end_step>`,
                ];
        if (method === "datawiseagent" && mode === "missing-report")
          responses.splice(1, 0, "```python\nprint(42)\n```\n<end_step>");
        const client = new ScriptClient((_body, index) => {
          if (
            mode === "cancel" &&
            index === (method === "datawiseagent" ? 1 : 0)
          )
            timer = setTimeout(() => controller.abort(), 300);
          return reply([], {
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: responses[index] ?? "unexpected",
                  reasoning_content: `r-${index}`,
                },
              },
            ],
          });
        });
        const task = validateTask({
          schema_version: 3,
          id: "failure",
          version: "1",
          goal: "report",
          constraints: [],
          inputs: [],
          output: {
            kind: "report",
            instructions: "report",
            report_file: "report.md",
            image_types: ["png"],
            max_images: 1,
            max_image_bytes: 10000,
            max_report_bytes: 10000,
          },
        });
        const result = await baselineAdapter(method, { client }).run(
          {
            schema_version: 3,
            evaluation_id: "test",
            unit_id: "unit-1",
            task,
            config: {
              id: method,
              adapter: method,
              model: profile,
              require_seed: true,
              options: {
                schema_version: 1,
                method,
                image: "statigent-runtime:baselines-cpu-v1",
                limits: { cell_timeout_ms: mode === "timeout" ? 300 : 20000 },
              },
            },
            budget: {
              timeout_ms: 30000,
              model_attempts: 4,
              total_tokens: 150000,
            },
            seed: 17,
            input_root: join(root, "input"),
            run_root: join(root, "runs"),
            deliverables_root: join(root, "output"),
            trajectory: false,
          },
          controller.signal,
        );
        expect(result.status).toBe(
          mode === "cancel"
            ? "cancelled"
            : mode === "timeout"
              ? "timed_out"
              : "failed",
        );
        expect(result.cleanup_error).toBeNull();
        expect(await Bun.file(join(root, "output/report.md")).exists()).toBe(
          false,
        );
        expect(client.bodies.length).toBe(
          method === "datawiseagent" ? (mode === "missing-report" ? 3 : 2) : 1,
        );
      } finally {
        clearTimeout(timer);
        await rm(root, { recursive: true, force: true });
      }
    }, 60000);
  }
