import { obj } from "../../src/models/validation";
import { call, lastFeedback, reply } from "./agent";
import { returned } from "./collaboration";
import {
  analyzeCall,
  finishCall,
  trainCall,
  updateCandidate,
} from "./modeling";
export const classifierBaseline =
  "from sklearn.dummy import DummyClassifier\ndef build_pipeline(seed):\n    return DummyClassifier(strategy='prior')\n";
export const classifierTree =
  "from sklearn.tree import DecisionTreeClassifier\ndef build_pipeline(seed):\n    return DecisionTreeClassifier(max_depth=3,random_state=seed)\n";
export function classificationScript() {
  let source = "";
  return (body: Record<string, unknown>, i: number) => {
    if (i === 0) return reply([trainCall(classifierBaseline)]);
    if (i === 1) {
      source = String(obj(lastFeedback(body).result).experiment_id);
      return reply([analyzeCall(source)]);
    }
    if (i === 2) {
      const a = obj(lastFeedback(body).result);
      const finding = obj((obj(a.analysis).findings as unknown[])[0]);
      const evidence = [
        {
          analysis_id: a.analysis_id,
          source_experiment: source,
          refs: finding.evidence_refs,
          applicability: "Same class order, predictions and split",
        },
      ];
      return reply([
        trainCall(classifierTree, evidence, source, {
          candidateUpdates: [updateCandidate("linear", evidence)],
        }),
      ]);
    }
    return reply([finishCall(body)]);
  };
}
export function classificationEdaScript() {
  let ref = "";
  return (body: Record<string, unknown>, i: number) => {
    if (i === 0)
      return reply([
        call("delegate_analysis", {
          task: "Check class-specific errors and probability calibration versus x",
          constraints: [],
        }),
      ]);
    if (i === 1)
      return reply([
        call("execute_python", {
          code: "import csv,json\nfrom pathlib import Path\nassert sorted(p.name for p in Path('/input').iterdir()) == ['context.json','source.json','split.json','train.csv','training-diagnostics.csv','validation.csv']\ns=json.loads(Path('/input/source.json').read_text())\nassert s['protocol']['kind'] in ['binary','multiclass']\nassert s['prediction_sha256']\nrows=list(csv.DictReader(open('/input/validation.csv')))\nassert all(r['target'] in s['protocol']['classes'] for r in rows)\nprint([(r['x'],r['target'],r[s['fields']['prediction']]) for r in rows])\nprint(s['fields'])",
        }),
      ]);
    if (i === 2) {
      ref = String(lastFeedback(body).cell_id);
      return reply([returned(body, [ref])]);
    }
    return reply([
      call("finish_analysis", {
        summary: "Class errors vary with x",
        findings: [
          {
            statement:
              "Class label is associated with x on the frozen validation rows",
            evidence_refs: [ref],
          },
        ],
        methods: ["Compare literal classes and predictions by feature x"],
        limitations: ["Synthetic internal validation only"],
      }),
    ]);
  };
}
