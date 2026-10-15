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
import { readPredictionManifest } from "../../src/evaluation/predictions";
import { reply, ScriptClient } from "../helpers/agent";
import {
  type BaselineForm,
  forms,
  genericTrainingCode,
  preparationCode,
} from "../helpers/baseline-forms";
import { modelingInvocation } from "../helpers/evaluation-modeling";

const matrix: [
  "react" | "autogen" | "datawiseagent" | "autogluon",
  readonly BaselineForm[],
][] = [
  ["react", ["regression", "binary-probability"]],
  ["autogen", ["binary-label"]],
  ["datawiseagent", ["regression", "ordinal", "top3"]],
  ["autogluon", forms.filter((f) => f !== "multilabel")],
];
for (const [method, selected] of matrix)
  for (const form of selected) {
    test(`${method} fits and independently predicts ${form} under frozen protocol`, async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), `baseline-${method}-${form}-`)),
      );
      try {
        const i = await modelingInvocation(root, preparationCode(form));
        i.config = {
          ...i.config,
          id: method,
          adapter: method,
          model: method === "autogluon" ? null : i.config.model,
          options: {
            schema_version: 1,
            method,
            image: `statigent-runtime:${method === "autogluon" ? "autogluon" : "baselines"}-cpu-v1`,
            delivery_reserve_ms: 45000,
          },
        };
        i.budget = {
          timeout_ms: 150000,
          model_attempts: method === "autogluon" ? null : 10,
          total_tokens: method === "autogluon" ? null : 150000,
        };
        const code = genericTrainingCode(),
          done = {
            kind: "predictions",
            bundle: "selected",
            entrypoint: "predict.py",
          };
        const responses =
          method === "react"
            ? [
                JSON.stringify({ action: "execute", code }),
                JSON.stringify({ action: "finish", submission: done }),
              ]
            : method === "autogen"
              ? [
                  "```python\nraise ValueError('repair this')\n```",
                  `\`\`\`python\n${code}\n\`\`\``,
                  `STATIGENT_FINAL\n${JSON.stringify(done)}`,
                ]
              : [
                  "```markdown\n[STEP GOAL] Fit the public targets\n```",
                  `\`\`\`python\n${code}\n\`\`\`\n<end_step>`,
                  `\`\`\`markdown\nSTATIGENT_FINAL\n${JSON.stringify(done)}\n\`\`\`\n<Fulfill USER INSTRUCTION>`,
                ];
        const client = new ScriptClient((_body, index) =>
          reply([], {
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: responses[index] ?? "Unexpected",
                  reasoning_content: `reason-${index}`,
                },
              },
            ],
          }),
        );
        const result = await baselineAdapter(
          method,
          method === "autogluon" ? {} : { client },
        ).run(i, new AbortController().signal);
        expect(result.reason).toBe("explicit_submission");
        expect(result.status).toBe("completed");
        expect(result.usage.attempts).toBe(
          method === "autogluon" ? 0 : responses.length,
        );
        const manifest = await readPredictionManifest(
          i.deliverables_root,
          i.task,
          { seed: i.seed, exported: false },
        );
        expect(manifest.producer?.method).toBe(method);
        const run = join(
          i.run_root,
          (await readdir(i.run_root))[0] ?? "missing",
        );
        expect(
          JSON.parse(
            await readFile(join(run, "prediction/prediction.json"), "utf8"),
          ).calls,
        ).toEqual({ models: 0, fits: 0 });
      } finally {
        for (const run of await readdir(join(root, "native")).catch(() => [])) {
          const files = join(root, "native", run, "bundle/files");
          if (await Bun.file(join(files, "predict.py")).exists())
            await chmod(files, 0o755);
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 210000);
  }
