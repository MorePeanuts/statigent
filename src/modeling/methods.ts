import type { Dataset } from "./data";
export function initialAnalysis(dataset: Dataset) {
  return {
    candidate_updates: [],
    purpose: "explore",
    candidates: [],
    source_experiments: [],
    question: `Examine the allowed training data for ${dataset.kind} prediction of ${dataset.target}. Which missingness, distributions or data-quality issues should inform an initial pipeline?`,
    expected_evidence:
      "A concise task-relevant overview with reproducible evidence and limitations. Do not train models or inspect external test data.",
  };
}
