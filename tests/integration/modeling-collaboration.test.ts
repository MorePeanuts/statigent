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
  const question = (revision: number, sources: unknown[], status = "open") => ({
    op: revision === 1 ? "create" : "revise",
    id: "q",
    kind: "question",
    base_revision: revision === 1 ? null : revision - 1,
    statement:
      revision === 1
        ? "What patterns could guide modeling?"
        : "Does validation support a linear feature?",
    status,
    reason: "Update understanding from actual evidence",
    sources,
    candidate_ids: revision === 1 ? [] : ["baseline"],
  });
  const client = new ScriptClient((body, i) => {
    if (i === 0)
      return reply([
        call("analyze", {
          candidate_updates: [],
          knowledge_updates: [question(1, [])],
          knowledge_refs: [{ id: "q", revision: 1 }],
          purpose: "explore",
          candidates: [],
          source_experiments: [],
          question: "Describe x and target",
          expected_evidence: "Numerical pattern",
        }),
      ]);
    if (i === 1) {
      firstAnalysis = obj(lastFeedback(body).result);
      const t = trainCall();
      return reply([
        call("run_experiment", {
          ...obj(JSON.parse(t.function.arguments)),
          knowledge_refs: [{ id: "q", revision: 1 }],
          knowledge_updates: [],
        }),
      ]);
    }
    if (i === 2) {
      baseline = String(obj(lastFeedback(body).result).experiment_id);
      const finding = obj(
        (obj(firstAnalysis.analysis).findings as unknown[])[0],
      );
      return reply([
        call("analyze", {
          candidate_updates: [],
          knowledge_updates: [
            question(2, [
              {
                kind: "analysis",
                analysis_id: firstAnalysis.analysis_id,
                finding: 0,
                evidence_refs: finding.evidence_refs,
                source_sha256: firstAnalysis.source_sha256,
                applicability: "Original data-only exploration",
              },
              { kind: "experiment", experiment_id: baseline, fact: "score" },
            ]),
          ],
          knowledge_refs: [{ id: "q", revision: 2 }],
          purpose: "diagnose",
          candidates: ["baseline"],
          source_experiments: [baseline],
          question: "Check remaining residual pattern",
          expected_evidence: "Residual trend",
        }),
      ]);
    }
    if (i === 3) {
      const t = trainCall(linearCode, [], baseline);
      return reply([
        call("run_experiment", {
          ...obj(JSON.parse(t.function.arguments)),
          reason:
            "Defer the latest diagnostic suggestion and directly test the earlier linear direction",
          knowledge_updates: [],
          knowledge_refs: [{ id: "q", revision: 2 }],
        }),
      ]);
    }
    return reply([
      call("finish_modeling", {
        candidate_updates: [],
        experiment_id: lastFeedback(body).best_experiment_id,
        reason: "Freeze both pipelines",
        knowledge_updates: [
          question(
            3,
            [
              {
                kind: "experiment",
                experiment_id: lastFeedback(body).best_experiment_id,
                fact: "score",
              },
            ],
            "resolved",
          ),
        ],
        knowledge_refs: [{ id: "q", revision: 3 }],
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
          code: `import json\nimport pandas as pd\nassert 'df' not in globals()\ncontext=json.load(open('/input/context.json'))\nassert context['knowledge']['entries'][0]['revision'] == ${revision}\ndf=pd.read_csv('/input/train.csv')\nprint(df[['x','target']].head().to_dict())\n`,
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
      schema_version: 2,
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
  const view = await inspectModeling(result.directory),
    analyses = (view.manifest.analyses as unknown[]).map(obj);
  expect(analyses).toHaveLength(2);
  expect(analyses[0]?.run_id).not.toBe(analyses[1]?.run_id);
  expect(obj(view.knowledge_control).history).toHaveLength(3);
  expect(view.unconfirmed_children).toHaveLength(0);
  const context = JSON.parse(
    await readFile(
      join(result.directory, `${String(analyses[1]?.id)}-input/context.json`),
      "utf8",
    ),
  );
  expect(context.knowledge.entries[0].revision).toBe(2);
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
    mode: "full_collaboration",
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
