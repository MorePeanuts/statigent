import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statigentAdapter } from "../../src/evaluation/agents/statigent";
import type { Invocation, PublicTask } from "../../src/evaluation/contracts";
import {
  freezeDeliverables,
  validateReport,
} from "../../src/evaluation/deliverables";
import { describeFile } from "../../src/evaluation/files";
import { sha256 } from "../../src/records/store";
import {
  call,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";

const chartsCode = `import pandas as pd, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
df = pd.read_csv("/input/data.csv")
for name, column in [("trend.png", "value"), ("share.png", "value")]:
    df[column].plot.bar(); plt.savefig(name); plt.close()
df.plot.line(); plt.savefig("unused.png"); plt.close()
open("report.md", "w").write("# Report\\n\\n![Trend](trend.png)\\n\\n![Share](./share.png)\\n")
print(df["value"].sum())`;
const output: PublicTask["output"] = {
  kind: "report",
  instructions: "Write report.md in English.",
  report_file: "report.md",
  image_types: ["png", "jpeg"],
  max_images: 5,
  max_image_bytes: 2097152,
  max_report_bytes: 65536,
};
async function invocation(
  root: string,
  unit: string,
  task: PublicTask,
): Promise<Invocation> {
  await mkdir(join(root, unit, "deliverables"), { recursive: true });
  return {
    schema_version: 2,
    evaluation_id: "eval-report-test",
    unit_id: unit,
    task,
    config: {
      id: "eda",
      adapter: "statigent-eda",
      options: { image: "statigent-runtime:dev" },
      model: profile,
      require_seed: true,
    },
    budget: { timeout_ms: 120000, model_attempts: 6, total_tokens: 1000000 },
    seed: 42,
    input_root: join(root, "input"),
    run_root: join(root, unit, "native"),
    deliverables_root: join(root, unit, "deliverables"),
    trajectory: false,
  };
}
test("real Docker: Statigent delivers the report and only its referenced charts; empty inputs start", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "report-int-")));
  try {
    await mkdir(join(root, "input"));
    await writeFile(join(root, "input/data.csv"), "value\n1\n2\n3\n");
    const input = await describeFile(join(root, "input"), "data.csv");
    const task: PublicTask = {
      schema_version: 2,
      id: "report",
      version: "v1",
      goal: "Summarize data.csv in a report with two charts.",
      constraints: [],
      inputs: [input],
      output,
    };
    let reportId = "";
    const client = new ScriptClient((body, n) => {
      if (n === 0) return reply([call("execute_python", { code: chartsCode })]);
      const feedback = lastFeedback(body);
      const artifacts = feedback.artifacts as {
        artifact_id: string;
        mime_type: string;
      }[];
      reportId =
        artifacts.find((a) => a.mime_type === "text/markdown")?.artifact_id ??
        "";
      const action = finish(String(feedback.cell_id));
      const args = JSON.parse(action.function.arguments);
      args.report_artifact_id = reportId;
      action.function.arguments = JSON.stringify(args);
      return reply([action]);
    });
    const adapter = statigentAdapter({ overrides: { client } });
    const i = await invocation(root, "unit-report", task);
    const s = await adapter.run(i);
    expect(s.status, s.reason).toBe("completed");
    expect(reportId).not.toBe("");
    const frozen = await freezeDeliverables(i.deliverables_root);
    expect(frozen.map((d) => d.path)).toEqual([
      "report.md",
      "share.png",
      "trend.png",
    ]);
    const report = await validateReport(output, i.deliverables_root, frozen);
    expect(report.images).toEqual(["trend.png", "share.png"]);
    for (const d of frozen)
      expect(d.sha256).toBe(
        sha256(await Bun.file(join(i.deliverables_root, d.path)).bytes()),
      );
    expect(await readdir(i.deliverables_root)).not.toContain("unused.png");
    // A question without data files still gets a session with an empty /input.
    const emptyClient = new ScriptClient((body, n) => {
      if (n === 0)
        return reply([
          call("execute_python", {
            code: 'import os\nprint(sorted(os.listdir("/input")))',
          }),
        ]);
      const feedback = lastFeedback(body);
      expect(feedback.preview).toContain("[]");
      return reply([finish(String(feedback.cell_id))]);
    });
    const empty = await statigentAdapter({
      overrides: { client: emptyClient },
    }).run(
      await invocation(root, "unit-empty", {
        ...task,
        id: "empty",
        inputs: [],
        output: { kind: "text", instructions: "Answer briefly." },
      }),
    );
    expect(empty.status, empty.reason).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
