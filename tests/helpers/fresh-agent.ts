import { obj } from "../../src/models/validation";
import { call, finish, lastFeedback, reply } from "./agent";
import { returned } from "./collaboration";
export const saveCsv =
  "import pandas as pd\nimport os\ndf=pd.read_csv('/input/synthetic.csv')\nmeans=df.groupby('group')['value'].mean()\nassert means.to_dict()=={'A':2.0,'B':4.0}\nout=os.path.join(os.getcwd(),'middle.csv')\nmeans.to_frame('mean_value').assign(n=2).to_csv(out)\nprint(means.to_json())";
export const readCsv =
  "import pandas as pd\nimport matplotlib.pyplot as plt\nassert 'df' not in globals()\nmeans=pd.read_csv('/workspace/middle.csv',index_col=0).iloc[:,0]\nassert means.to_dict()=={'A':2.0,'B':4.0}\nmeans.plot.bar()\nplt.tight_layout()\nplt.savefig('means.png')\nplt.close()\nprint(means.to_json())";
export function freshAgentScript(
  organization: "single" | "planner-executor",
  repair = false,
) {
  const refs: string[] = [];
  let failed = false;
  return (body: Record<string, unknown>, originalIndex: number) => {
    const i = originalIndex - Number(failed);
    if (organization === "single") {
      if (i === 0 && repair && !failed) {
        failed = true;
        return reply([
          call("execute_python", {
            code: "open('partial.txt','w').write('partial')\nraise ValueError('SECRET_REPAIR_TRACE')",
          }),
        ]);
      }
      if (i === 0 || i === 1) {
        if (i === 1) refs.push(String(lastFeedback(body).execution_id));
        return reply([
          call("execute_python", {
            code:
              i === 0
                ? saveCsv
                : readCsv +
                  "\nopen('report.md','w').write('# Group means\\nA=2, B=4.\\n![Means](means.png)')",
          }),
        ]);
      }
      const f = lastFeedback(body);
      const artifacts = f.artifacts as {
        artifact_id: string;
        mime_type: string;
      }[];
      return reply([
        call("finish_analysis", {
          ...obj(JSON.parse(finish(String(f.execution_id)).function.arguments)),
          report_artifact_id: artifacts.find(
            (a) => a.mime_type === "text/markdown",
          )?.artifact_id,
        }),
      ]);
    }
    if (i === 0 || i === 3) {
      if (
        i === 3 &&
        /SECRET_REPAIR_TRACE|pd.read_csv/.test(JSON.stringify(body.messages))
      )
        throw Error("Planner history leak");
      return reply([
        call("delegate_analysis", {
          task:
            i === 0
              ? "Compute means and save middle.csv"
              : "Read saved means in a new script and plot",
          constraints: [],
        }),
      ]);
    }
    if (i === 1 && repair && !failed) {
      failed = true;
      return reply([
        call("execute_python", {
          code: "raise ValueError('SECRET_REPAIR_TRACE')",
        }),
      ]);
    }
    if (i === 1 || i === 4)
      return reply([
        call("execute_python", { code: i === 1 ? saveCsv : readCsv }),
      ]);
    if (i === 2 || i === 5) {
      const f = lastFeedback(body);
      const current = [
        String(f.execution_id),
        ...(f.artifacts as { artifact_id: string }[]).map((a) => a.artifact_id),
      ];
      refs.push(...current);
      return reply([returned(body, current)]);
    }
    const f = lastFeedback(body),
      images = f.images as { reference: string }[];
    return reply([
      call("finish_analysis", {
        ...obj(JSON.parse(finish(refs[0] ?? "").function.arguments)),
        report_markdown: `# Group means\nA=2, B=4.\n![Means](${images[0]?.reference})`,
      }),
    ]);
  };
}
