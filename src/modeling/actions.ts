import type { ModelingMethod } from "./config";
import { MODELING_PROMPT as LEGACY_PROMPT } from "./legacy-actions";
import { type ModelingProtocol, metricDirection } from "./versioned-score";

export type { EvidenceUse } from "./candidates";
export { identifier } from "./candidates";
export type { CoreAction as ModelingAction } from "./workflow";
export const MODELING_PROMPT_VERSION = "modeling-v7";
export const MODELING_PROMPT_V2_VERSION = "modeling-v10";
export function modelingTools(
  protocol: ModelingProtocol,
  method: ModelingMethod,
) {
  const text = { type: "string", minLength: 1 };
  const sources = {
    type: "array",
    maxItems: 16,
    items: {
      type: "object",
      properties: { source_id: text, applicability: text },
      required: ["source_id"],
      additionalProperties: false,
    },
  };
  const shared = {
    sources,
    ...(method === "collaborative"
      ? {
          notes: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description:
                  "Optional replacement note, at most 8 KiB; omit to retain, empty to clear.",
              },
              sources,
            },
            required: ["text"],
            additionalProperties: false,
          },
        }
      : {}),
  };
  const definitions = [
    {
      name: "run_experiment",
      description:
        "Train and validate one complete pipeline. Explain the change and reason; host assigns experiment IDs and computes scores.",
      properties: {
        ...shared,
        code: text,
        change: text,
        reason: text,
        source_experiment: text,
        repair_of_experiment: text,
      },
      required: ["code", "change", "reason"],
    },
    ...(method === "adaptive_eda" || method === "collaborative"
      ? [
          {
            name: "analyze",
            description:
              "Ask a focused data question; omit sources to explore, provide one successful search experiment to diagnose or two to compare. Host allocates resources.",
            properties: {
              ...shared,
              question: text,
              source_experiments: {
                type: "array",
                items: text,
                maxItems: 2,
                uniqueItems: true,
              },
            },
            required: ["question"],
          },
        ]
      : []),
    {
      name: "finish_modeling",
      description:
        "End search. Host chooses the best validated pipelines, performs frozen confirmation and delivers. No further LLM calls.",
      properties: { ...shared, reason: text },
      required: ["reason"],
    },
  ];
  return definitions.map((d) => ({
    type: "function",
    function: {
      name: d.name,
      description: `${d.description} ${protocol.kind}: ${metricDirection(protocol)} ${protocol.version === 2 ? protocol.metric.id : protocol.metric}, output ${protocol.output}.`,
      parameters: {
        type: "object",
        properties: d.properties,
        required: d.required,
        additionalProperties: false,
      },
    },
  }));
}
const runnerContract = LEGACY_PROMPT.split("\n").slice(0, 2).join("\n");
export function modelingPrompt(
  method: ModelingMethod,
  protocolVersion: 1 | 2 = 1,
) {
  const contract =
    protocolVersion === 1
      ? runnerContract
      : `Write Python defining build_pipeline(seed), returning an estimator with fit(X,y), predict(X), and predict_proba(X) when required by the frozen protocol. The runner fits preprocessing only on the allowed training members. X is a pandas DataFrame containing every whitelisted feature in frozen order, decoded using the full feature schema; summaries may omit display columns without removing data.
Regression y is a one-dimensional numeric array. Single-target classification and ordinal y contain encoded class indices in the frozen per-target class order; ordinal original levels are metadata, not an assumption of consecutive numeric targets. Single-target classifiers must expose classes_ containing the encoded integer indices (including custom wrappers); predict returns encoded integer indices, not original labels or floating-point values. predict_proba columns must match classes_ order. Multilabel y is a DataFrame containing ALL target names in frozen order, each independently encoded as 0/1; expose a classes_ list and predict_proba list in that same target order. Each target's probabilities sum to one independently. For ranked-labels output provide predict_proba; the runner aligns classes and creates up to three distinct labels with frozen-class-order tie breaking. The host validates and scores canonical predictions. Do not read test data or labels during search, confirmation or final fitting.`;
  const environment =
    protocolVersion === 2
      ? "\nAvailable: pandas, numpy, scipy, scikit-learn, joblib. No network/package installation. Return a serializable pipeline with all fitted preprocessing inside it. Prediction runs in a NEW container loading the saved model and candidate module; do not depend on prior process state. Define custom classes and functions at module level, not inside build_pipeline, so the model can be serialized and reloaded. build_pipeline(seed) must accept any unsigned 32-bit integer seed (0 through 4294967295); search, confirmation and final fitting may receive different seeds. Use the supplied seed for randomness. If deriving component seeds, calculate with Python integers and normalize each derived seed, for example (int(seed) * 10 + i) % (2**32), before passing it as random_state. Do not assume the seed is small or hard-code the search seed. Do not use host paths, manually load datasets, or report self-computed validation scores."
      : "";
  return `${contract}${environment}
Autonomously build an effective, reliable predictive model. Use the task, data profile, experiment feedback and available analysis to choose the next useful action. Establish a competitive initial pipeline when the available understanding supports it. Analyze a focused uncertainty when its answer can change a modeling decision; otherwise train directly. Use actual validation feedback to retain or revise your explanations and test promising changes. No prescribed model family, EDA count or action order. Stop when no worthwhile supported direction remains.
Tools express the next action only: analyze(question, optional source_experiments), run_experiment(code, change, reason, optional source_experiment/repair_of_experiment), finish_modeling(reason). The host owns experiment IDs, source binding, ranking and resource protection. A repair references an actually failed search experiment. You do not manage candidate lists or select the best ID at finish.
Optional sources use published source_id handles: profile:/rows, analysis:<id>:<finding index>, experiment:<id>:score/failure/train_diagnostic. Explain applicability when useful; do not relabel historical diagnostics as measurements of a different model. Invalid optional notes/references are reported as warnings and ignored; valid core actions still run. Core errors must be corrected. Never fabricate sources or scores.
Training metrics diagnose fit and are not validation scores. Compare only the frozen validation metric. After finish, the host confirms up to two pipelines on two frozen internal splits when configured, then fits on all allowed training data and predicts. This internal adaptive confirmation is not independent generalization evidence. Confirmation and finalization need no LLM. Resource protection may close search; protected delivery is recorded separately from autonomous completion.
Method: ${method}. ${method === "collaborative" ? "You may keep a concise notes object {text,sources?} to carry data understanding, explanations and next questions across decisions and into EDA. Replace it when useful; omit unchanged notes. These are provisional judgments, not certified facts. No types, statuses, IDs or revision numbers are needed. Use experiment results to revise explanations; code failures do not refute statistical hypotheses." : "Use ordinary task, report and experiment history. No additional notes state is enabled."}`;
}
