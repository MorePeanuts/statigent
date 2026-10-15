import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineAdapter } from "../../src/baselines/adapter";
import { reply, ScriptClient } from "../helpers/agent";
import { genericTrainingCode } from "../helpers/baseline-forms";
import { modelingInvocation } from "../helpers/evaluation-modeling";

for (const method of ["react", "autogen", "datawiseagent"] as const)
  for (const registered of [true, false]) {
    test(`${method} budget closing ${registered ? "uses explicit registration" : "does not guess a bundle"}`, async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "baseline-closing-")),
      );
      try {
        const i = await modelingInvocation(root);
        i.config = {
          ...i.config,
          id: method,
          adapter: method,
          options: {
            schema_version: 1,
            method,
            image: "statigent-runtime:baselines-cpu-v1",
            delivery_reserve_ms: 30000,
          },
        };
        i.budget = {
          timeout_ms: 90000,
          model_attempts: 2,
          total_tokens: 100000,
        };
        const code = genericTrainingCode(),
          registration = { bundle: "selected", entrypoint: "predict.py" };
        const responses =
          method === "react"
            ? [
                JSON.stringify({ action: "execute", code }),
                registered
                  ? JSON.stringify({
                      action: "register_bundle",
                      ...registration,
                    })
                  : "I have a model",
              ]
            : method === "autogen"
              ? [
                  `\`\`\`python\n${code}\n\`\`\``,
                  registered
                    ? `STATIGENT_BUNDLE\n${JSON.stringify(registration)}`
                    : "A model is ready",
                ]
              : [
                  "```markdown\n[STEP GOAL] Fit\n```",
                  `\`\`\`python\n${code}\n\`\`\`\n${registered ? `\`\`\`markdown\nSTATIGENT_BUNDLE\n${JSON.stringify(registration)}\n\`\`\`\n` : ""}<end_step>`,
                ];
        const client = new ScriptClient((_body, index) =>
          reply([], {
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: responses[index] ?? "unexpected",
                  reasoning_content: `reason-${index}`,
                },
              },
            ],
          }),
        );
        const result = await baselineAdapter(method, { client }).run(
          i,
          new AbortController().signal,
        );
        if (result.usage.attempts !== 2) throw new Error(result.reason);
        expect(result.usage.attempts).toBe(2);
        if (registered && result.status !== "completed")
          throw new Error(result.reason);
        expect(result.status === "completed").toBe(registered);
        expect(
          await Bun.file(join(i.deliverables_root, "predictions.csv")).exists(),
        ).toBe(registered);
        if (registered) {
          expect(result.reason).toBe("delivered_after_budget_exhausted");
          const manifest = await Bun.file(
            join(i.deliverables_root, "prediction-manifest.json"),
          ).json();
          expect(manifest.workflow.search_end.status).toBe("budget_exhausted");
        }
        const runs = await readdir(i.run_root);
        const record = JSON.parse(
          await readFile(
            join(i.run_root, runs[0] ?? "missing", "baseline.json"),
            "utf8",
          ),
        );
        expect(record.cleanup_error).toBeNull();
      } finally {
        for (const run of await readdir(join(root, "native")).catch(() => [])) {
          const files = join(root, "native", run, "bundle/files");
          if (await Bun.file(join(files, "predict.py")).exists())
            await chmod(files, 0o755);
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 150000);
  }
