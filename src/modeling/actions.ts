import { integer, keys, obj, str, strings } from "../models/validation";
export interface EvidenceUse {
  analysis_id: string;
  source_experiment: string | null;
  refs: string[];
  applicability: string;
}
export interface Candidate {
  id: string;
  change: string;
  priority: number;
}
export type ModelingAction =
  | {
      kind: "train";
      candidate_id: string;
      hypothesis: string;
      change: string;
      reason: string;
      source_experiment: string | null;
      evidence: EvidenceUse[];
      code: string;
    }
  | {
      kind: "analyze";
      candidates: Candidate[];
      question: string;
      expected_evidence: string;
      decision_rules: string;
      source_experiment: string | null;
    }
  | { kind: "finish"; experiment_id: string; reason: string };
const text = { type: "string", minLength: 1 };
const nullable = { type: ["string", "null"] };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const ev = object({
  analysis_id: text,
  source_experiment: nullable,
  refs: { type: "array", items: text, minItems: 1 },
  applicability: text,
});
export const MODELING_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_experiment",
      description:
        "Train one complete pipeline on the fixed internal split. Use evidence references after analysis, or explain a direct trial. Never claim a score; the host computes RMSE.",
      parameters: object({
        candidate_id: text,
        hypothesis: text,
        change: text,
        reason: text,
        source_experiment: nullable,
        evidence: { type: "array", items: ev },
        code: text,
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "analyze",
      description:
        "Delegate one bounded uncertainty to the complete EDA agent. Specify how possible evidence changes candidate priorities. Only internal training/validation data is available.",
      parameters: object({
        candidates: {
          type: "array",
          items: object({
            id: text,
            change: text,
            priority: { type: "integer", minimum: 1 },
          }),
          minItems: 1,
        },
        question: text,
        expected_evidence: text,
        decision_rules: text,
        source_experiment: nullable,
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "finish_modeling",
      description:
        "Freeze the current best successful experiment and fit on all allowed training data, then predict. Reserve enough time; no model calls occur after acceptance.",
      parameters: object({ experiment_id: text, reason: text }),
    },
  },
];
function short(v: unknown, name: string) {
  const s = str(v, name);
  if (Buffer.byteLength(s) > 8192) throw new Error(`${name} too long`);
  return s;
}
export function identifier(v: unknown) {
  const s = str(v, "identity");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) throw new Error("Invalid identity");
  return s;
}
const source = (v: unknown) => (v === null ? null : identifier(v));
export function action(
  name: string,
  args: string,
  codeLimit: number,
  maxCandidates: number,
): ModelingAction {
  const x = obj(JSON.parse(args));
  if (name === "finish_modeling") {
    keys(x, ["experiment_id", "reason"]);
    return {
      kind: "finish",
      experiment_id: identifier(x.experiment_id),
      reason: short(x.reason, "reason"),
    };
  }
  if (name === "analyze") {
    keys(x, [
      "candidates",
      "question",
      "expected_evidence",
      "decision_rules",
      "source_experiment",
    ]);
    if (
      !Array.isArray(x.candidates) ||
      !x.candidates.length ||
      x.candidates.length > maxCandidates
    )
      throw new Error("Invalid candidate count");
    const candidates = x.candidates.map((v: unknown) => {
      const c = obj(v);
      keys(c, ["id", "change", "priority"]);
      return {
        id: identifier(c.id),
        change: short(c.change, "change"),
        priority: integer(c.priority, "priority"),
      };
    });
    if (new Set(candidates.map((c) => c.id)).size !== candidates.length)
      throw new Error("Duplicate candidate");
    return {
      kind: "analyze",
      candidates,
      question: short(x.question, "question"),
      expected_evidence: short(x.expected_evidence, "expected evidence"),
      decision_rules: short(x.decision_rules, "decision rules"),
      source_experiment: source(x.source_experiment),
    };
  }
  if (name !== "run_experiment") throw new Error("Unknown modeling action");
  keys(x, [
    "candidate_id",
    "hypothesis",
    "change",
    "reason",
    "source_experiment",
    "evidence",
    "code",
  ]);
  if (!Array.isArray(x.evidence) || x.evidence.length > 32)
    throw new Error("Invalid evidence uses");
  const evidence = x.evidence.map((v: unknown) => {
    const e = obj(v);
    keys(e, ["analysis_id", "source_experiment", "refs", "applicability"]);
    const refs = strings(e.refs, "refs");
    if (!refs.length || refs.length > 32)
      throw new Error("Invalid evidence refs");
    return {
      analysis_id: identifier(e.analysis_id),
      source_experiment: source(e.source_experiment),
      refs: refs.map(identifier),
      applicability: short(e.applicability, "applicability"),
    };
  });
  const code = str(x.code, "code");
  if (Buffer.byteLength(code) > codeLimit)
    throw new Error("Code limit exceeded");
  return {
    kind: "train",
    candidate_id: identifier(x.candidate_id),
    hypothesis: short(x.hypothesis, "hypothesis"),
    change: short(x.change, "change"),
    reason: short(x.reason, "reason"),
    source_experiment: source(x.source_experiment),
    evidence,
    code,
  };
}
export const MODELING_PROMPT_VERSION = "modeling-v1";
export const MODELING_PROMPT = `You are the modeling agent for a regression task. Choose exactly one tool call per turn. You own candidate selection, code and final decisions. The host owns immutable data splits, fit/predict stages, RMSE (lower is better), budgets and final delivery.
Write Python source exporting build_pipeline(seed), returning a sklearn-compatible estimator/pipeline with fit(X,y) and predict(X). X is a pandas DataFrame without ID or target. Available: pandas, numpy, scipy, scikit-learn, joblib. No network/package installation. Fit sees only internal training data; predict runs in a NEW container loading the saved model and your candidate module. Keep transformations inside the pipeline, use deterministic seeds, and return predictions on the original target scale. No host paths, manual dataset loading, self-reported scores or state from previous experiments.
Start with a modest competitive pipeline. You may directly train when evidence is enough. For uncertain alternatives, call analyze with specific candidates, the question and how evidence will change your choice. EDA independently uses its planner and executor; request only useful statistics, not a broad report. After analysis, link exact evidence and its source experiment to the next training decision and explain applicability. Diagnostic observations do not prove the change will help. Never pretend evidence from one model diagnoses a different model. Report a failed experiment as failed; improve code in a new experiment within budget.
Use feedback best_experiment_id for finish_modeling. Worse later scores do not replace it. Keep time for final fit/predict and choose finish before model budget runs out. Do not optimize against external test results or claim research benefits.`;
