import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { prepareDataset } from "../../src/modeling/data";
import { reproduce } from "../../src/modeling/delivery";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { obj } from "../../src/models/validation";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { returned } from "../helpers/collaboration";
import { finishCall, trainCall } from "../helpers/modeling";

test("initial EDA runs before the first decision in Docker and retains shared training and delivery", async () => {
  const root = resolve("runs/integration-methods", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "data"));
  let ref = "";
  const edaClient = new ScriptClient((body, i) => {
    if (i === 0)
      return reply([
        call("delegate_analysis", {
          task: "Inspect allowed training data",
          constraints: [],
        }),
      ]);
    if (i === 1)
      return reply([
        call("execute_python", {
          code: "import pandas as pd\nfrom pathlib import Path\nassert not Path('/input/validation.csv').exists()\nprint(pd.read_csv('/input/train.csv').shape)",
        }),
      ]);
    if (i === 2) {
      ref = String(lastFeedback(body).cell_id);
      return reply([returned(body, [ref])]);
    }
    return reply([
      call("finish_analysis", {
        summary: "Training shape checked",
        findings: [{ statement: "Small training table", evidence_refs: [ref] }],
        methods: ["Read training table"],
        limitations: ["No predictive claim"],
      }),
    ]);
  });
  const client = new ScriptClient((body, i) => {
    expect(edaClient.bodies).toHaveLength(4);
    return reply([i === 0 ? trainCall() : finishCall(body)]);
  });
  const result = await runModeling({
    task: {
      schema_version: 3,
      method: "initial_eda",
      confirmation: { mode: "none" },
      resource_version: "smoke-v1",
      goal: "predict",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client,
    edaClient,
  });
  expect(result.status, result.reason).toBe("completed");
  const view = await inspectModeling(result.directory);
  expect(view.manifest.analyses).toHaveLength(1);
  expect(view.manifest.usage).toMatchObject({
    eda_calls: 1,
    training_attempts: 2,
    tokens: { attempts: 6, total_tokens: 90 },
  });
  expect(obj(view.manifest.config).task).toMatchObject({
    method: "initial_eda",
  });
  expect(view.knowledge_control).toBe("disabled");
  expect(
    (await reproduce(result.directory, join(root, "reproduce"))).status,
  ).toBe("passed");
}, 120000);
