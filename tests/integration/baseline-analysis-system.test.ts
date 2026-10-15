import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineAdapter } from "../../src/baselines/adapter";
import { exportComparison } from "../../src/evaluation/comparison";
import {
  type BenchmarkAdapter,
  validateTask,
} from "../../src/evaluation/contracts";
import { validateReport } from "../../src/evaluation/deliverables";
import { describeFile } from "../../src/evaluation/files";
import { buildPlan, Registry } from "../../src/evaluation/plan";
import { command } from "../../src/evaluation/process";
import { inspect } from "../../src/evaluation/records";
import { createReport } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { profile, reply, ScriptClient } from "../helpers/agent";

test("three actual methods traverse report plan/run/score/compare with SQLite, workbook and image", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "baseline-analysis-system-")),
  );
  try {
    await mkdir(join(root, "data"));
    await command(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-c",
        `import sqlite3,pandas as pd,sys\nfrom pathlib import Path\np=Path(sys.argv[1]); c=sqlite3.connect(p/'data.db');c.execute('create table values_table(x integer)');c.executemany('insert into values_table values (?)',[(40,),(2,)]);c.commit();c.close();pd.DataFrame({'x':[40,2]}).to_excel(p/'data.xlsx',index=False)`,
        join(root, "data"),
      ],
      { timeout_ms: 20000 },
    );
    const task = validateTask({
      schema_version: 2,
      id: "report",
      version: "synthetic-v1",
      goal: "Verify the sum in SQLite and workbook, report with a chart",
      constraints: [],
      inputs: await Promise.all(
        ["data.db", "data.xlsx"].map((p) =>
          describeFile(join(root, "data"), p),
        ),
      ),
      output: {
        kind: "report",
        report_file: "report.md",
        instructions: "Include a chart",
        image_types: ["png"],
        max_images: 2,
        max_image_bytes: 1048576,
        max_report_bytes: 10000,
      },
    });
    const benchmark: BenchmarkAdapter = {
      id: "baseline-analysis-fixture",
      version: "1",
      protocol: "report-fixture-v1",
      options: () => ({}),
      catalog: async () => ({
        tasks: [task],
        source_root: join(root, "data"),
        provenance: { synthetic: true, version: "synthetic-v1" },
      }),
      preflight: async () => {},
      score: async (_o, t, s, c) => {
        const report = await validateReport(
          t.output,
          c.deliverables_root,
          s.deliverables,
        );
        return {
          schema_version: 2,
          unit_id: s.unit_id,
          protocol: "report-fixture-v1",
          status: "scored",
          metrics: [
            {
              name: "correct",
              value: Number(
                s.status === "completed" &&
                  report.report.includes("42") &&
                  report.images.length === 1,
              ),
              minimum: 0,
              maximum: 1,
              direction: "higher",
            },
          ],
          details: { synthetic: true },
          error: null,
          judge: null,
        };
      },
    };
    const registry = new Registry().benchmark(benchmark),
      agents = [];
    for (const method of ["react", "autogen", "datawiseagent"] as const) {
      const code =
        "import sqlite3,pandas as pd,matplotlib.pyplot as plt\nfrom pathlib import Path\nc=sqlite3.connect('file:/input/data.db?mode=ro',uri=True);a=c.execute('select sum(x) from values_table').fetchone()[0];c.close()\nb=pd.read_excel('/input/data.xlsx').x.sum();assert a==b==42\nplt.bar(['database','workbook'],[a,b]);plt.savefig('/workspace/plot.png');plt.close()\nPath('/workspace/report.md').write_text('# Result\\nBoth sums are 42.\\n![plot](plot.png)')";
      const done = { kind: "report", path: "report.md" };
      const responses =
        method === "react"
          ? [
              JSON.stringify({ action: "execute", code }),
              JSON.stringify({ action: "finish", submission: done }),
            ]
          : method === "autogen"
            ? [
                `\`\`\`python\n${code}\n\`\`\``,
                `STATIGENT_FINAL\n${JSON.stringify(done)}`,
              ]
            : [
                "```markdown\n[STEP GOAL] Verify and report\n```",
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
                content: responses[index] ?? "unexpected",
                reasoning_content: `reason-${index}`,
              },
            },
          ],
        }),
      );
      registry.agent(baselineAdapter(method, { client }));
      agents.push({
        id: method,
        adapter: method,
        model: profile,
        require_seed: true,
        options: {
          schema_version: 1,
          method,
          image: "statigent-runtime:baselines-cpu-v1",
        },
      });
    }
    const plan = await buildPlan(
      {
        schema_version: 2,
        purpose: "development",
        development_overlap: "synthetic only",
        benchmark: {
          adapter: benchmark.id,
          version: "synthetic-v1",
          options: {},
          task_ids: [task.id],
        },
        agents,
        repetitions: 1,
        seed: 17,
        task_budget: {
          timeout_ms: 60000,
          model_attempts: 10,
          total_tokens: 150000,
        },
        batch_budget: {
          timeout_ms: 180000,
          model_attempts: 30,
          total_tokens: 450000,
        },
      },
      registry,
    );
    const run = await runEvaluation(plan, registry, join(root, "runs"), {
        environment: { synthetic: true },
      }),
      view = await inspect(run.directory);
    expect(view.records.map((r) => r.execution_status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(view.records.map((r) => r.score?.metrics[0]?.value)).toEqual([
      1, 1, 1,
    ]);
    const report = await createReport(
        run.directory,
        registry,
        undefined,
        run.score_id,
      ),
      comparison = await exportComparison(run.directory, report.score_id);
    expect(comparison.planned).toBe(3);
    expect(report.report.rows.every((r) => r.method_source)).toBe(true);
    expect(report.report.rows.map((r) => r.total_tokens)).toEqual([30, 30, 45]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
