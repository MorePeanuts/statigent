import { keys, obj, str, strings } from "../models/validation";
import { type RequestedBudget, requestedBudget } from "./budget";
import {
  type CandidateUpdate,
  type EvidenceUse,
  identifier,
  parseCandidateUpdates,
  parseEvidence,
  short,
  source,
} from "./candidates";

export type { EvidenceUse } from "./candidates";
export { identifier } from "./candidates";
export type ModelingAction = (
  | {
      kind: "train";
      candidate_id: string;
      change: string;
      reason: string;
      source_experiment: string | null;
      repair_of_experiment: string | null;
      evidence: EvidenceUse[];
      code: string;
    }
  | {
      kind: "analyze";
      candidates: string[];
      question: string;
      expected_evidence: string;
      decision_rules: string;
      source_experiment: string | null;
      requested_budget: RequestedBudget;
      budget_reason: string;
    }
  | { kind: "finish"; experiment_id: string; reason: string }
) & { candidate_updates: CandidateUpdate[] };
const text = { type: "string", minLength: 1 };
const nullable = { type: ["string", "null"] };
const positive = { type: "integer", minimum: 1 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const ev = object({
  analysis_id: text,
  source_experiment: nullable,
  refs: { type: "array", items: text, minItems: 1, maxItems: 32 },
  applicability: text,
});
const evidence = { type: "array", items: ev, maxItems: 32 };
const candidateUpdates = {
  type: "array",
  items: {
    anyOf: [
      object({
        op: { type: "string", enum: ["create"] },
        id: text,
        hypothesis: text,
        change: text,
        priority: positive,
        reason: text,
        evidence,
      }),
      object({
        op: { type: "string", enum: ["update"] },
        id: text,
        priority: { type: ["integer", "null"], minimum: 1 },
        disposition: { type: "string", enum: ["keep", "defer", "resume"] },
        reason: text,
        evidence,
      }),
    ],
  },
};
export const MODELING_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_experiment",
      description:
        "Train one complete pipeline for an existing or newly created candidate. A repair references a confirmed failed experiment of the same candidate. The host computes RMSE and associates a new experiment ID.",
      parameters: object({
        candidate_updates: candidateUpdates,
        candidate_id: text,
        change: text,
        reason: text,
        source_experiment: nullable,
        repair_of_experiment: nullable,
        evidence,
        code: text,
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "analyze",
      description:
        "Delegate one bounded uncertainty to the complete EDA planner/executor. Reference active candidate IDs and request only the useful time/token/execution allowance. The host clips allowances against configured limits and remaining parent resources.",
      parameters: object({
        candidate_updates: candidateUpdates,
        candidates: { type: "array", items: text, minItems: 1 },
        question: text,
        expected_evidence: text,
        decision_rules: text,
        source_experiment: nullable,
        requested_budget: object({
          task_timeout_ms: positive,
          total_tokens: positive,
          executions: positive,
        }),
        budget_reason: text,
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "finish_modeling",
      description:
        "Freeze the current best successful experiment and fit on all allowed training data, then predict. Optionally defer remaining candidates in this same decision; no model calls occur after acceptance.",
      parameters: object({
        candidate_updates: candidateUpdates,
        experiment_id: text,
        reason: text,
      }),
    },
  },
];
export function action(
  name: string,
  args: string,
  codeLimit: number,
  maxCandidates: number,
): ModelingAction {
  const x = obj(JSON.parse(args));
  const candidate_updates = parseCandidateUpdates(
    x.candidate_updates,
    maxCandidates,
  );
  if (name === "finish_modeling") {
    keys(x, ["candidate_updates", "experiment_id", "reason"]);
    return {
      kind: "finish",
      candidate_updates,
      experiment_id: identifier(x.experiment_id),
      reason: short(x.reason, "reason"),
    };
  }
  if (name === "analyze") {
    keys(x, [
      "candidate_updates",
      "candidates",
      "question",
      "expected_evidence",
      "decision_rules",
      "source_experiment",
      "requested_budget",
      "budget_reason",
    ]);
    const candidates = strings(x.candidates, "candidates").map(identifier);
    if (!candidates.length || candidates.length > maxCandidates)
      throw new Error("Invalid candidate count");
    if (new Set(candidates).size !== candidates.length)
      throw new Error("Duplicate candidate");
    return {
      kind: "analyze",
      candidate_updates,
      candidates,
      question: short(x.question, "question"),
      expected_evidence: short(x.expected_evidence, "expected evidence"),
      decision_rules: short(x.decision_rules, "decision rules"),
      source_experiment: source(x.source_experiment),
      requested_budget: requestedBudget(x.requested_budget),
      budget_reason: short(x.budget_reason, "budget reason"),
    };
  }
  if (name !== "run_experiment") throw new Error("Unknown modeling action");
  keys(x, [
    "candidate_updates",
    "candidate_id",
    "change",
    "reason",
    "source_experiment",
    "repair_of_experiment",
    "evidence",
    "code",
  ]);
  const code = str(x.code, "code");
  if (Buffer.byteLength(code) > codeLimit)
    throw new Error("Code limit exceeded");
  return {
    kind: "train",
    candidate_updates,
    candidate_id: identifier(x.candidate_id),
    change: short(x.change, "change"),
    reason: short(x.reason, "reason"),
    source_experiment: source(x.source_experiment),
    repair_of_experiment: source(x.repair_of_experiment),
    evidence: parseEvidence(x.evidence),
    code,
  };
}
export const MODELING_PROMPT_VERSION = "modeling-v2";
export const MODELING_PROMPT = `You are the modeling agent for a regression task. Choose exactly one tool call per turn. You own candidate selection, code and final decisions. The host owns immutable data splits, fit/predict stages, RMSE (lower is better), budgets and final delivery.
Write Python source exporting build_pipeline(seed), returning a sklearn-compatible estimator/pipeline with fit(X,y) and predict(X). X is a pandas DataFrame without ID or target. Available: pandas, numpy, scipy, scikit-learn, joblib. No network/package installation. Fit sees only internal training data; predict runs in a NEW container loading the saved model and your candidate module. Keep transformations inside the pipeline, use deterministic seeds, and return predictions on the original target scale. No host paths, manual dataset loading, self-reported scores or state from previous experiments.
Maintain a small candidate list through candidate_updates on every tool (use [] when unchanged). Create candidates with {op:"create",id,hypothesis,change,priority,reason,evidence:[]}; priority is a positive integer, smaller first. Candidate ID, core hypothesis and direction never change. Update with {op:"update",id,priority:null,disposition:"keep",reason,evidence:[]}; set a positive priority to change ranking, "defer" to pause, or "resume" to reactivate. The host derives pending/tried from actual attempts; deferred candidates must be resumed before analyze/train, which can happen in the same action. You may select any active candidate regardless of rank; explain why. Never submit experiment_ids, status, revision or scores as candidate updates. Candidate creation/update and the action are accepted together or all rejected.
Start with a modest competitive pipeline, creating its candidate in the first run_experiment. Training refers to candidate_id; its change describes this particular implementation or parameter adjustment, not a new core hypothesis. Use a new candidate for a different direction. Same-direction trials and code repairs keep the candidate ID and always create a new experiment. For a code repair, set repair_of_experiment to the confirmed failed search experiment of the SAME candidate; otherwise null. Unknown or successful experiments cannot be repair sources. Failure does not by itself refute the candidate hypothesis.
You may directly train when evidence is enough. For uncertain alternatives, call analyze with candidate IDs, a focused question, expected evidence and how evidence will change your choice. EDA independently uses its planner and executor. Each call requires requested_budget:{task_timeout_ms,total_tokens,executions} with positive integers and a nonempty budget_reason. Request a proportionate allowance for the question, not automatically the maximum. The host clips against configured ceilings and remaining parent resources, preserving final delivery time. All EDA roles and retries share the effective allowance. Only actual usage is charged. Tokens are a stop threshold; a dispatched response may overshoot and must still be fully counted. A known child budget failure is not evidence; an unknown cost stops the entire task. Do not assume failed EDA is automatically rerun with a larger allowance.
After successful analysis, update candidate reasons/priorities or deferral decisions based on exact evidence, and link exact evidence and its source experiment in the next training action itself. Candidate update evidence alone does not replace training evidence. Explain applicability; diagnostic observations do not prove improvement. Never pretend evidence from one model diagnoses a different model. Feedback includes the current candidate summary, latest experiment facts, actual analysis allowance and remaining budgets.
Use feedback best_experiment_id for finish_modeling. Worse later scores do not replace it. Keep time for final fit/predict and choose finish before model budget runs out. You may update/defer other candidates in finish_modeling. Do not optimize against external test results or claim research benefits.`;
