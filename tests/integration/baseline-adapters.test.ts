import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineAdapter } from "../../src/baselines/adapter";
import { readBaselineRecord } from "../../src/baselines/records";
import { validateTask } from "../../src/evaluation/contracts";
import { describeFile } from "../../src/evaluation/files";
import { profile, reply, ScriptClient } from "../helpers/agent";

for (const method of ["react", "autogen", "datawiseagent"] as const) {
  test(`${method} adapter uses actual method, Docker and explicit text submission`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), `baseline-${method}-`)),
    );
    await mkdir(join(root, "input"));
    await mkdir(join(root, "output"));
    await writeFile(join(root, "input/data.csv"), "x\n40\n2\n");
    const code =
      "import pandas as pd\nprint(pd.read_csv('/input/data.csv').x.sum())";
    const responses =
      method === "react"
        ? [
            JSON.stringify({ action: "execute", code }),
            JSON.stringify({
              action: "finish",
              submission: { kind: "text", answer: "42" },
            }),
          ]
        : method === "autogen"
          ? [
              `\`\`\`python\n${code}\n\`\`\``,
              'STATIGENT_FINAL\n{"kind":"text","answer":"42"}',
            ]
          : [
              "```markdown\n[STEP GOAL] Sum the allowed data\n```",
              `\`\`\`python\n${code}\n\`\`\`\n<end_step>`,
              '```markdown\nSTATIGENT_FINAL\n{"kind":"text","answer":"42"}\n```\n<Fulfill USER INSTRUCTION>',
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
    try {
      const task = validateTask({
        schema_version: 3,
        id: "sum",
        version: "v1",
        goal: "Sum x",
        constraints: [],
        inputs: [await describeFile(join(root, "input"), "data.csv")],
        output: { kind: "text", instructions: "Return sum" },
      });
      const adapter = baselineAdapter(method, { client });
      const config = {
        id: method,
        adapter: method,
        options: {
          schema_version: 1,
          method,
          image: "statigent-runtime:baselines-cpu-v1",
        },
        model: profile,
        require_seed: true,
      };
      const result = await adapter.run(
        {
          schema_version: 3,
          evaluation_id: "baseline-eval",
          unit_id: `unit-${method}`,
          task,
          config,
          budget: {
            model_attempts: 10,
            total_tokens: 150000,
            timeout_ms: 60000,
          },
          seed: 7,
          input_root: join(root, "input"),
          run_root: join(root, "runs"),
          deliverables_root: join(root, "output"),
          trajectory: true,
        },
        new AbortController().signal,
      );
      expect(result.status).toBe("completed");
      expect(result.answer_text).toBe("42");
      expect(result.native_run).toBeNull();
      expect(result.usage.attempts).toBe(responses.length);
      const directories = await readdir(join(root, "runs"));
      const directory = join(root, "runs", directories[0] ?? "missing");
      const record = await readBaselineRecord(directory);
      expect(record.status).toBe("completed");
      expect(record.method.method).toBe(method);
      expect(
        await readFile(join(root, "output/trajectory.txt"), "utf8"),
      ).toContain("print(pd.read_csv");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
}
