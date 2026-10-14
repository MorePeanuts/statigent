import { randomUUID } from "node:crypto";
import {
  ChatClient,
  parseResponse,
  type RequestLimits,
} from "../models/client";
import { validateProfile } from "../models/config";
import type { ProtocolV2 } from "./protocol-v2";

export const DETERMINISTIC_PROFILE = validateProfile({
  id: "deterministic-modeling-v1",
  provider: "generic",
  protocol: "chat-completions",
  base_url: "https://unused.invalid",
  model: "fixed-tree-v1",
  display_name: "Fixed tree verification",
  api_key_env: "STATIGENT_UNUSED_KEY",
  capabilities: { tool_calls: true, thinking: false, vision: false },
  generation: { max_output_tokens: 4096 },
});
export function deterministicPipeline(p: ProtocolV2) {
  const estimator =
    p.kind === "regression"
      ? "DecisionTreeRegressor"
      : "DecisionTreeClassifier";
  return `from sklearn.compose import ColumnTransformer, make_column_selector
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.impute import SimpleImputer
from sklearn.tree import ${estimator}
from sklearn.multioutput import MultiOutputClassifier
import numpy as np
def build_pipeline(seed):
    numeric = make_pipeline(SimpleImputer(strategy="median", keep_empty_features=True))
    categorical = make_pipeline(SimpleImputer(strategy="most_frequent", keep_empty_features=True), OneHotEncoder(handle_unknown="ignore", sparse_output=True))
    features = ColumnTransformer([("numeric", numeric, make_column_selector(dtype_include=np.number)), ("categorical", categorical, make_column_selector(dtype_exclude=np.number))])
    model = ${estimator}(max_depth=8, random_state=seed)
    return make_pipeline(features, ${p.kind === "multilabel" ? "MultiOutputClassifier(model)" : "model"})
`;
}

/** 固定决策仅用于确定性软件验收；不请求模型服务，也不声称智能体效果。 */
export class DeterministicModelingClient extends ChatClient {
  calls = 0;
  constructor(private readonly code: string) {
    super(DETERMINISTIC_PROFILE, { STATIGENT_UNUSED_KEY: "not-a-credential" });
  }
  override async send(
    _body: string,
    _limits: RequestLimits,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.calls >= 2)
      throw new Error("Deterministic verification has exactly two decisions");
    const training = this.calls++ === 0;
    return parseResponse(
      {
        id: randomUUID(),
        model: DETERMINISTIC_PROFILE.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: training ? "run_experiment" : "finish_modeling",
                    arguments: JSON.stringify(
                      training
                        ? {
                            code: this.code,
                            change: "fixed tree",
                            reason: "deterministic verification",
                          }
                        : { reason: "fixed verification complete" },
                    ),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      this.profile,
      0,
    );
  }
}
