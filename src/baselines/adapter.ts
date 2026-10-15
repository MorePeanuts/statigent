import { inspectImage } from "../evaluation/agents/docker";
import type { AgentAdapter } from "../evaluation/contracts";
import {
  validateInvocation,
  validateSubmission,
} from "../evaluation/contracts";
import { validateImageBackend } from "../execution/docker";
import { resolveCredential } from "../models/config";
import {
  baselineOptionsSchema,
  methodConfigIdentity,
  methodManifest,
} from "./catalog";
import { runBaseline } from "./host";
import { environmentIdentity, verifyDatawiseSource } from "./source";

export function baselineAdapter(
  method: "react" | "autogen" | "datawiseagent" | "autogluon",
  dependencies: Parameters<typeof runBaseline>[2] = {},
): AgentAdapter {
  const options = (value: unknown) => {
    const result = baselineOptionsSchema.parse(value);
    if (result.method !== method)
      throw new Error("Baseline adapter/method mismatch");
    return result;
  };
  const verify = async (value: unknown) => {
    const settings = options(value);
    if (method === "autogen" || method === "datawiseagent")
      await environmentIdentity(method);
    if (method === "datawiseagent") await verifyDatawiseSource();
    const image = await (dependencies.image ?? inspectImage)(settings.image);
    validateImageBackend(
      settings.backend === "automl" ? "fresh-script" : settings.backend,
      image.runtime_labels,
    );
    return image;
  };
  return {
    id: method,
    version: methodManifest(method).version,
    capabilities: {
      schema_version: 3,
      outputs:
        method === "autogluon"
          ? ["predictions"]
          : ["text", "report", "predictions"],
      phase_isolation: true,
      trajectory: "unified",
      model: method === "autogluon" ? "none" : "configurable",
      seed: "execution",
      isolation: "docker",
      model_budget: method !== "autogluon",
      usage: method === "autogluon" ? "not_applicable" : "measured",
    },
    options,
    async preview(config) {
      if (method !== "autogluon" && !config.model)
        throw new Error("Baseline model profile required");
      if (method === "autogluon" && config.model)
        throw new Error("AutoML does not accept a model profile");
      await verify(config.options);
    },
    async preflight(config) {
      if (method !== "autogluon" && !config.model)
        throw new Error("Baseline model profile required");
      if (method === "autogluon" && config.model)
        throw new Error("AutoML does not accept a model profile");
      if (!dependencies.client && config.model) resolveCredential(config.model);
      const image = await verify(config.options);
      return {
        ...image,
        method: methodManifest(method),
        requested_config_hash: methodConfigIdentity(config.options),
        config_hash: methodConfigIdentity({
          ...options(config.options),
          image: image.image_id,
        }),
        configuration: options(config.options),
        model: config.model,
        capabilities: this.capabilities,
        budget_source: "invocation.effective_budget",
        internal_validation: "method-managed-training-only",
        phase_policy: "search-freeze-independent-predict-v1",
      };
    },
    async run(value, signal) {
      const i = validateInvocation(value);
      options(i.config.options);
      return validateSubmission(
        await runBaseline(i, signal, dependencies),
        i.unit_id,
        { output: i.task.output, frozen: false },
      );
    },
  };
}
