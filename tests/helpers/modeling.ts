import { obj } from "../../src/models/validation";
import { call, lastFeedback, reply } from "./agent";
import { returned } from "./collaboration";
export const baselineCode =
  "from sklearn.dummy import DummyRegressor\ndef build_pipeline(seed):\n    return DummyRegressor()\n";
export const linearCode =
  "from sklearn.compose import ColumnTransformer\nfrom sklearn.pipeline import make_pipeline\nfrom sklearn.linear_model import LinearRegression\ndef build_pipeline(seed):\n    return make_pipeline(ColumnTransformer([('x', 'passthrough', ['x'])]), LinearRegression())\n";
export function trainCall(
  code = baselineCode,
  evidence: unknown[] = [],
  source: string | null = null,
) {
  return call("run_experiment", {
    candidate_id: source ? "linear" : "baseline",
    hypothesis: "Inspect systematic residual dependence on x",
    change: source ? "Use x linear regression" : "Mean prediction",
    reason: source ? "Evidence supports testing x" : "Establish reference",
    source_experiment: source,
    evidence,
    code,
  });
}
export function modelingScript(worse = false) {
  let source = "";
  return (body: Record<string, unknown>, i: number) => {
    if (i === 0) return reply([trainCall()]);
    if (i === 1) {
      source = String(obj(lastFeedback(body).result).experiment_id);
      return reply([
        call("analyze", {
          candidates: [{ id: "linear", change: "Use x", priority: 1 }],
          question: "Are baseline residuals related to x?",
          expected_evidence: "Compare x with residuals",
          decision_rules:
            "If systematic, prioritize linear fit; otherwise keep mean",
          source_experiment: source,
        }),
      ]);
    }
    if (i === 2) {
      const a = obj(lastFeedback(body).result),
        analysis = obj(a.analysis),
        finding = obj((analysis.findings as unknown[])[0]);
      return reply([
        trainCall(
          worse
            ? baselineCode.replace(
                "DummyRegressor()",
                "DummyRegressor(strategy='constant', constant=1000)",
              )
            : linearCode,
          [
            {
              analysis_id: a.analysis_id,
              source_experiment: source,
              refs: finding.evidence_refs,
              applicability:
                "Same fixed validation split and baseline predictions",
            },
          ],
          source,
        ),
      ]);
    }
    return reply([
      call("finish_modeling", {
        experiment_id: lastFeedback(body).best_experiment_id,
        reason: "Use lowest observed RMSE",
      }),
    ]);
  };
}
export function modelingEdaScript() {
  let ref = "";
  return (body: Record<string, unknown>, i: number) => {
    if (i === 0)
      return reply([
        call("delegate_analysis", {
          task: "Compare baseline residuals with x in validation.csv",
          constraints: [],
        }),
      ]);
    if (i === 1)
      return reply([
        call("execute_python", {
          code: "import pandas as pd\nfrom pathlib import Path\nassert 'df' not in globals()\nassert sorted(p.name for p in Path('/input').iterdir()) == ['source.json','split.json','train.csv','validation.csv']\ndf=pd.read_csv('/input/validation.csv')\nprint((df['target']-df['__prediction']).tolist())\nprint(df['x'].tolist())",
        }),
      ]);
    if (i === 2) {
      ref = String(lastFeedback(body).cell_id);
      return reply([returned(body, [ref])]);
    }
    return reply([
      call("finish_analysis", {
        summary: "Residuals depend on x",
        findings: [
          {
            statement:
              "Residual increases with x on the fixed internal validation sample",
            evidence_refs: [ref],
          },
        ],
        methods: [
          "Compared validation target minus baseline prediction with x",
        ],
        limitations: [
          "Small synthetic validation set; test a model before claiming improvement",
        ],
      }),
    ]);
  };
}
