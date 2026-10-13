import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { prepareDataset } from "../../src/modeling/data";
import { reproduce } from "../../src/modeling/delivery";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { validateSmoke } from "../../src/modeling/smoke";
import { obj } from "../../src/models/validation";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { returned } from "../helpers/collaboration";
import { linearCode, trainCall } from "../helpers/modeling";

test("full Docker collaboration transfers revised knowledge across isolated EDA sessions and confirms delivery", async () => {
  const root = resolve("runs/integration-collaboration", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "data"));
  let firstAnalysis: Record<string, unknown> = {},
    baseline = "",
    ref = "";
  const client = new ScriptClient((body, i) => {
    if ([0, 1, 3].includes(i)) {
      if (i === 3) firstAnalysis = obj(lastFeedback(body).result);
      return reply([
        call("analyze", {
          question: 42,
          notes: { text: "invalid core must not replace notes" },
        }),
      ]);
    }
    if (i === 2)
      return reply([
        call("analyze", {
          question: "Describe x and target",
          notes: { text: "What patterns could guide modeling?" },
        }),
      ]);
    if (i === 4) return reply([trainCall()]);
    if (i === 5) {
      baseline = String(obj(lastFeedback(body).result).experiment_id);
      return reply([
        call("analyze", {
          question: "Check remaining residual pattern",
          source_experiments: [baseline],
          notes: {
            text: "Does validation support a linear feature?",
            sources: [
              { source_id: `analysis:${firstAnalysis.analysis_id}:0` },
              { source_id: `experiment:${baseline}:score` },
            ],
          },
        }),
      ]);
    }
    if (i === 6) {
      const analysis = obj(lastFeedback(body).result);
      return reply([
        call("run_experiment", {
          code: linearCode,
          change: "Test linear x",
          reason: "Test the observed residual dependence",
          source_experiment: baseline,
          sources: [{ source_id: `analysis:${analysis.analysis_id}:0` }],
        }),
      ]);
    }
    return reply([
      call("finish_modeling", {
        reason: "Freeze both pipelines",
        notes: {
          text: "Linear modeling validated on the internal split",
          sources: [
            {
              source_id: `experiment:${lastFeedback(body).best_experiment_id}:score`,
            },
          ],
        },
      }),
    ]);
  });
  const edaClient = new ScriptClient((body, i) => {
    const step = i % 4,
      revision = Math.floor(i / 4) + 1;
    if (step === 0)
      return reply([
        call("delegate_analysis", {
          task: "Inspect the supplied data and context",
          constraints: [],
        }),
      ]);
    if (step === 1)
      return reply([
        call("execute_python", {
          code: `import json\nimport pandas as pd\nassert 'df' not in globals()\ncontext=json.load(open('/input/context.json'))\nassert context['notes']['revision'] == ${revision}\ndf=pd.read_csv('/input/train.csv')\nprint(df[['x','target']].head().to_dict())\n`,
        }),
      ]);
    if (step === 2) {
      ref = String(lastFeedback(body).cell_id);
      return reply([returned(body, [ref])]);
    }
    return reply([
      call("finish_analysis", {
        summary: "Numeric pattern inspected",
        findings: [
          {
            statement:
              "The displayed training sample shows target increasing with x",
            evidence_refs: [ref],
          },
        ],
        methods: ["Read allowed training rows"],
        limitations: ["Descriptive observation; verify through training"],
      }),
    ]);
  });
  const result = await runModeling({
    task: {
      schema_version: 3,
      method: "collaborative",
      confirmation: { mode: "terminal_repeated_holdout" },
      resource_version: "collaboration-test-v1",
      goal: "Exercise the complete collaboration protocol",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
      budget: {
        training_attempts: 8,
        eda_calls: 2,
        task_timeout_ms: 1200000,
        final_reserve_ms: 750000,
      },
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client,
    edaClient,
  });
  expect(result.status, result.reason).toBe("completed");
  expect(client.bodies).toHaveLength(8);
  const journal = (
    await readFile(join(result.directory, "events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => obj(JSON.parse(line)));
  expect(
    journal
      .filter((event) => event.type === "action_rejected")
      .map((event) => event.consecutive_rejections),
  ).toEqual([1, 2, 1]);
  const view = await inspectModeling(result.directory),
    analyses = (view.manifest.analyses as unknown[]).map(obj);
  expect(analyses).toHaveLength(2);
  expect(analyses[0]?.run_id).not.toBe(analyses[1]?.run_id);
  expect(obj(view.manifest.notes_control).history).toHaveLength(3);
  expect(view.unconfirmed_children).toHaveLength(0);
  const context = JSON.parse(
    await readFile(
      join(result.directory, `${String(analyses[1]?.id)}-input/context.json`),
      "utf8",
    ),
  );
  expect(context.notes.revision).toBe(2);
  expect(obj(view.manifest.confirmation).status).toBe("complete");
  expect(view.manifest.usage).toMatchObject({
    eda_calls: 2,
    confirmation_training_attempts: 4,
    training_attempts: 7,
  });
  expect(
    (await reproduce(result.directory, join(root, "reproductions"))).status,
  ).toBe("passed");
  expect(await validateSmoke(result.directory)).toMatchObject({
    collaboration: "covered",
  });
  for (const path of [
    join(result.directory, `${String(analyses[1]?.id)}-input/context.json`),
    join(String(analyses[1]?.directory), "analysis.json"),
  ]) {
    const original = await Bun.file(path).text();
    const mode = (await stat(path)).mode & 0o777;
    // Simulate host-side tampering of the otherwise read-only test artifact.
    await chmod(path, 0o600);
    try {
      await Bun.write(path, "{}");
      await expect(inspectModeling(result.directory)).rejects.toThrow();
    } finally {
      await Bun.write(path, original);
      await chmod(path, mode);
    }
  }
}, 240000);
