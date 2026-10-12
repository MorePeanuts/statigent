import { obj } from "../../src/models/validation";
import { call, finish, lastFeedback, reply } from "./agent";
import { returned } from "./collaboration";

export const loadMeans =
  'import os\nfrom pathlib import Path\nimport pandas as pd\nassert "DEEPSEEK_API_KEY" not in os.environ\nassert not Path("/Users").exists()\nassert sorted(p.name for p in Path("/input").iterdir()) == ["synthetic.csv"]\nassert "df" not in globals()\ndf = pd.read_csv("/input/synthetic.csv")\nmeans = df.groupby("group")["value"].mean()\nprint(means.to_json())';
export const reuseMeans =
  'best = means.idxmax()\ncentered = df.loc[df["group"] == best, "value"] - means[best]\nprint(centered.tolist())\nimport matplotlib.pyplot as plt\nmeans.plot.bar()\nplt.tight_layout()\nplt.savefig("means.png")\nplt.close()';

/** Scripted fixture uses two bounded questions; production prompts do not mandate a count. */
export function collaborationScript(repair = false) {
  const refs: string[] = [];
  let failed = false;
  return (body: Record<string, unknown>, originalIndex: number) => {
    const i = originalIndex - Number(failed);
    if (i === 0 || i === 3) {
      if (i === 3) {
        const content = JSON.stringify(body.messages);
        if (
          content.includes("SECRET_REPAIR_TRACE") ||
          content.includes("pd.read_csv")
        )
          throw new Error("Planner context leak");
      }
      return reply([
        call("delegate_analysis", {
          task:
            i === 0
              ? "Compute group means"
              : "Use the highest mean group to inspect centered values and plot means",
          constraints: [],
        }),
      ]);
    }
    if (i === 1 && repair && !failed) {
      failed = true;
      return reply([
        call("execute_python", {
          code: 'repair_state = 7\nraise ValueError("SECRET_REPAIR_TRACE")',
        }),
      ]);
    }
    if (i === 1 || i === 4)
      return reply([
        call("execute_python", {
          code:
            i === 1
              ? (repair ? "assert repair_state == 7\n" : "") + loadMeans
              : reuseMeans,
        }),
      ]);
    if (i === 2 || i === 5) {
      const f = lastFeedback(body);
      const artifacts = f.artifacts as { artifact_id: string }[];
      const current = [
        String(f.cell_id),
        ...artifacts.map((a) => a.artifact_id),
      ];
      refs.push(...current);
      return reply([
        returned(body, current, {
          findings: [
            {
              statement: "Verified results",
              value: {
                group_means: { A: 2, B: 4 },
                ...(i === 5 ? { centered_values: [-2, 2] } : {}),
              },
              evidence_refs: current,
            },
          ],
        }),
      ]);
    }
    const feedback = lastFeedback(body);
    const images = feedback.images as { reference: string }[];
    const args = obj(JSON.parse(finish(String(refs[0])).function.arguments));
    args.findings = [
      {
        statement: "Means and within-group deviations",
        value: { group_means: { A: 2, B: 4 }, centered_values: [-2, 2] },
        evidence_refs: refs,
      },
    ];
    return reply([
      call("finish_analysis", {
        ...args,
        report_markdown: `# Group differences\nA: 2; B: 4. B deviations: -2, 2. Only two observations per group.\n![Means](${images[0]?.reference})`,
      }),
    ]);
  };
}
