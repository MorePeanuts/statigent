import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { baselineAdapter } from "../../src/baselines/adapter";
import { reproduceBaseline } from "../../src/baselines/reproduce";
import { createModelingBenchmark } from "../../src/evaluation/benchmarks/modeling/adapter";
import { exportComparison } from "../../src/evaluation/comparison";
import { describeFile } from "../../src/evaluation/files";
import { buildPlan, Registry } from "../../src/evaluation/plan";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { inspect } from "../../src/evaluation/records";
import { createReport, rescore } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { profile, reply, ScriptClient } from "../helpers/agent";
import {
  genericTrainingCode,
  preparationCode,
} from "../helpers/baseline-forms";

test("four real modeling methods run/score/compare, reproduce and rescore without model storage", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "baseline-modeling-system-")),
  );
  try {
    const prepare = preparationCode("regression").replace(
      "explicit_split=",
      "provenance=dict(benchmark='dsbench-modeling',task_id='fixture',source_revision='a'*40,export=dict(columns=['Id','y'],identity='source-row')),explicit_split=",
    );
    await command(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-c",
        prepare,
        join(root, "data"),
      ],
      {
        timeout_ms: 20000,
        env: {
          ...commandEnvironment(),
          PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
        },
      },
    );
    const benchmark = createModelingBenchmark("dsbench-modeling", {
        references: async (_r, _t, _d, value) => ({
          rpg: value === null ? null : Math.max(0, (value - 20) / (2 - 20)),
          reference_identity: { synthetic: true },
          dependencies: {},
        }),
      }),
      registry = new Registry().benchmark(benchmark),
      agents = [];
    const code = genericTrainingCode(),
      done = {
        kind: "predictions",
        bundle: "selected",
        entrypoint: "predict.py",
      };
    for (const method of [
      "react",
      "autogen",
      "datawiseagent",
      "autogluon",
    ] as const) {
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
                "```markdown\n[STEP GOAL] Fit\n```",
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
                reasoning_content: `r-${index}`,
              },
            },
          ],
        }),
      );
      registry.agent(
        baselineAdapter(method, method === "autogluon" ? {} : { client }),
      );
      agents.push({
        id: method,
        adapter: method,
        model: method === "autogluon" ? null : profile,
        require_seed: true,
        options: {
          schema_version: 1,
          method,
          image: `statigent-runtime:${method === "autogluon" ? "autogluon" : "baselines"}-cpu-v1`,
          delivery_reserve_ms: 45000,
        },
      });
    }
    const plan = await buildPlan(
      {
        schema_version: 3,
        cache_policy: "disabled",
        purpose: "development",
        development_overlap: "synthetic only",
        benchmark: {
          adapter: benchmark.id,
          version: "a".repeat(40),
          options: {
            prepared_root: root,
            datasets: { fixture: "data" },
            data_root: root,
          },
          task_ids: ["fixture"],
        },
        agents,
        repetitions: 1,
        seed: 17,
        task_budget: {
          timeout_ms: 150000,
          model_attempts: 10,
          total_tokens: 150000,
        },
        batch_budget: {
          timeout_ms: 600000,
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
      "completed",
    ]);
    expect(view.records.every((r) => r.scoring_status === "scored")).toBe(true);
    const report = await createReport(
        run.directory,
        registry,
        undefined,
        run.score_id,
      ),
      compared = await exportComparison(run.directory, report.score_id);
    expect(compared.planned).toBe(4);
    expect(report.report.rows.map((r) => r.confirmation)).toEqual(
      Array(4).fill("not_applicable"),
    );
    for (const row of report.report.rows)
      expect(row.method_config_hash).toBe(
        (row.producer as { config_hash: string }).config_hash,
      );
    expect(report.report.rows[3]?.attempts).toBe(0);
    expect(report.report.rows[3]?.usage_source).toBe("not_applicable");
    const native = join(run.directory, "native"),
      firstUnit = view.records[0]?.unit.id ?? "missing",
      first = join(
        native,
        firstUnit,
        (await readdir(join(native, firstUnit)))[0] ?? "missing",
      );
    const replay = await reproduceBaseline(
      first,
      join(root, "replay"),
      45000,
      new AbortController().signal,
    );
    expect(replay.status).toBe("passed");
    const entry = join(first, "bundle/files/predict.py");
    await chmod(entry, 0o600);
    await writeFile(entry, `${await readFile(entry, "utf8")}\n# changed`);
    const tamper = await reproduceBaseline(
      first,
      join(root, "tampered"),
      45000,
      new AbortController().signal,
    );
    expect(tamper.status).toBe("failed");
    expect(tamper.reason).toContain("Bundle");
    const immutable = await Promise.all(
      [
        "plan.json",
        "manifest.json",
        ...view.records.flatMap((r) => [
          `units/${r.unit.id}/record.json`,
          `units/${r.unit.id}/submission.json`,
        ]),
      ].map((p) => describeFile(run.directory, p)),
    );
    await rename(native, join(root, "moved-models"));
    const rescored = await rescore(run.directory, registry);
    expect(rescored.report.scores.map((s) => s.score?.metrics)).toEqual(
      report.report.scores.map((s) => s.score?.metrics),
    );
    for (const f of immutable)
      expect(await describeFile(run.directory, f.path)).toEqual(f);
  } finally {
    // 冻结根目录不可写；只解锁本测试创建的临时目录后删除。
    async function unlock(dir: string) {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      )) {
        if (e.isDirectory()) {
          const p = join(dir, e.name);
          await chmod(p, 0o755);
          await unlock(p);
        }
      }
    }
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  }
}, 660000);
