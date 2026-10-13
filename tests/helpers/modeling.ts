import { obj } from "../../src/models/validation";
import { call, lastFeedback, reply } from "./agent";
import { returned } from "./collaboration";
export const baselineCode =
  "from sklearn.dummy import DummyRegressor\ndef build_pipeline(seed):\n    return DummyRegressor()\n";
export const linearCode =
  "from sklearn.compose import ColumnTransformer\nfrom sklearn.pipeline import make_pipeline\nfrom sklearn.linear_model import LinearRegression\ndef build_pipeline(seed):\n    return make_pipeline(ColumnTransformer([('x', 'passthrough', ['x'])]), LinearRegression())\n";
export function createCandidate(
  id: string,
  priority = 1,
  evidence: unknown[] = [],
) {
  return {
    op: "create",
    id,
    hypothesis:
      id === "baseline"
        ? "Mean provides a reference"
        : "Residual dependence supports testing linear x",
    change: id === "baseline" ? "Mean prediction" : "Use x linear regression",
    priority,
    reason: "Test a bounded modeling hypothesis",
    evidence,
  };
}
export function updateCandidate(
  id: string,
  evidence: unknown[] = [],
  disposition = "keep",
  priority: number | null = 1,
) {
  return {
    op: "update",
    id,
    priority,
    disposition,
    reason: "Evidence determines the next bounded experiment",
    evidence,
  };
}
export function trainCall(
  code = baselineCode,
  evidence: unknown[] = [],
  source: string | null = null,
  options: {
    candidateId?: string;
    candidateUpdates?: unknown[];
    repairOf?: string | null;
  } = {},
) {
  const candidate = options.candidateId ?? (source ? "linear" : "baseline");
  return call("run_experiment", {
    candidate_updates: options.candidateUpdates ?? [createCandidate(candidate)],
    candidate_id: candidate,
    change: source ? "Use x linear regression" : "Mean prediction",
    reason: source ? "Evidence supports testing x" : "Establish reference",
    source_experiment: source,
    repair_of_experiment: options.repairOf ?? null,
    evidence,
    code,
  });
}
export function analyzeCall(
  source: string | null,
  options: {
    candidates?: string[];
    candidateUpdates?: unknown[];
  } = {},
) {
  return call("analyze", {
    candidate_updates: options.candidateUpdates ?? [createCandidate("linear")],
    candidates: options.candidates ?? ["linear"],
    question: "Are baseline residuals related to x?",
    expected_evidence: "Compare x with residuals",
    purpose: source === null ? "explore" : "diagnose",
    source_experiments: source === null ? [] : [source],
  });
}
export function finishCall(
  body: Record<string, unknown>,
  candidateUpdates: unknown[] = [],
) {
  return call("finish_modeling", {
    candidate_updates: candidateUpdates,
    experiment_id: lastFeedback(body).best_experiment_id,
    reason: "Use lowest observed RMSE",
  });
}
export function modelingScript(worse = false, repair = false) {
  let source = "";
  let evidence: unknown[] = [];
  return (body: Record<string, unknown>, i: number) => {
    if (i === 0) return reply([trainCall()]);
    if (i === 1) {
      source = String(obj(lastFeedback(body).result).experiment_id);
      return reply([analyzeCall(source)]);
    }
    if (i === 2) {
      const a = obj(lastFeedback(body).result),
        analysis = obj(a.analysis),
        finding = obj((analysis.findings as unknown[])[0]);
      evidence = [
        {
          analysis_id: a.analysis_id,
          source_experiment: source,
          refs: finding.evidence_refs,
          applicability: "Same fixed validation split and baseline predictions",
        },
      ];
      return reply([
        trainCall(
          repair
            ? "def build_pipeline(seed):\n    raise ValueError('planned repairable feature failure')\n"
            : worse
              ? baselineCode.replace(
                  "DummyRegressor()",
                  "DummyRegressor(strategy='constant', constant=1000)",
                )
              : linearCode,
          evidence,
          source,
          { candidateUpdates: [updateCandidate("linear", evidence)] },
        ),
      ]);
    }
    if (repair && i === 3) {
      return reply([
        trainCall(linearCode, evidence, source, {
          candidateUpdates: [],
          repairOf: String(obj(lastFeedback(body).result).experiment_id),
        }),
      ]);
    }
    return reply([finishCall(body)]);
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
          code: "import pandas as pd\nfrom pathlib import Path\nassert 'df' not in globals()\nassert sorted(p.name for p in Path('/input').iterdir()) == ['context.json','source.json','split.json','train.csv','validation.csv']\ndf=pd.read_csv('/input/validation.csv')\nprint((df['target']-df['__prediction']).tolist())\nprint(df['x'].tolist())",
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
