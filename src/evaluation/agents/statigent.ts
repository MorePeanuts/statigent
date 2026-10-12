import { PROMPT_VERSION, SYSTEM_PROMPT } from "../../agent/prompt";
import { type RunOptions, runAgent } from "../../agent/run";
import { resolveCredential } from "../../models/config";
import { keys, obj, str } from "../../models/validation";
import { inspectModelJournal, readManifest, sha256 } from "../../records/store";
import {
  type AgentAdapter,
  emptyUsage,
  type Submission,
  validateInvocation,
  validateSubmission,
} from "../contracts";
import { inspectImage } from "./docker";

export function statigentAdapter(
  dependencies: {
    run?: typeof runAgent;
    overrides?: Partial<RunOptions>;
    image?: typeof inspectImage;
  } = {},
): AgentAdapter {
  const options = (value: unknown) => {
    const x = obj(value);
    keys(x, ["image"]);
    return { image: str(x.image, "image") };
  };
  return {
    id: "statigent-eda",
    version: "1",
    capabilities: {
      schema_version: 1,
      output: "text",
      model: "configurable",
      seed: "execution",
      isolation: "docker",
      model_budget: true,
      usage: "measured",
    },
    options,
    async preflight(config) {
      if (!config.model) throw new Error("Model profile required");
      if (!dependencies.overrides?.client) resolveCredential(config.model);
      return {
        ...(await (dependencies.image ?? inspectImage)(
          str(options(config.options).image, "image"),
        )),
        prompt: {
          version: PROMPT_VERSION,
          sha256: sha256(Buffer.from(SYSTEM_PROMPT)),
        },
        role: "single",
        backend: "persistent-kernel",
        capabilities: this.capabilities,
      };
    },
    async run(value, signal) {
      const i = validateInvocation(value);
      const profile = i.config.model;
      if (
        !profile ||
        i.budget.model_attempts === null ||
        i.budget.total_tokens === null
      )
        throw new Error("Model and budgets required");
      const result = await (dependencies.run ?? runAgent)({
        ...dependencies.overrides,
        profile,
        task: {
          goal: i.task.goal,
          constraints: [
            ...i.task.constraints,
            `Final answer format: ${i.task.output.instructions}`,
            "Place the final answer exactly in analysis.summary; put evidence, methods and limitations in the other fields.",
          ],
          model_profile: profile.id,
          execution: {
            image: str(options(i.config.options).image, "image"),
            input_root: i.input_root,
            inputs: i.task.inputs.map((f) => f.path),
            seed: i.seed,
          },
          budget: {
            model_attempts: i.budget.model_attempts,
            total_tokens: i.budget.total_tokens,
            task_timeout_ms: i.budget.timeout_ms,
          },
        },
        runRoot: i.run_root,
        signal,
      });
      const s: Submission = {
        schema_version: 1,
        unit_id: i.unit_id,
        status: result.status,
        reason: result.reason,
        answer_text: result.analysis?.summary ?? "",
        artifacts: [],
        native_run: { id: result.run_id, directory: result.directory },
        usage: emptyUsage("unknown"),
        record_error: result.record_error,
        cleanup_error: result.reason.includes("cleanup") ? result.reason : null,
      };
      try {
        const manifest = await readManifest(result.directory),
          journal = await inspectModelJournal(result.directory);
        if (manifest.tokens === "not_applicable")
          throw new Error("Missing model ledger");
        const t = manifest.tokens;
        const unknown = Math.max(
          t.unknown_attempts,
          journal.unresolved_attempts.length,
          journal.journal_truncated ? 1 : 0,
        );
        s.usage = {
          source: unknown ? "unknown" : "measured",
          attempts: Math.max(t.attempts, journal.requests, unknown),
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          total_tokens: t.total_tokens,
          unknown_attempts: unknown,
          currency_cost: "not_computed",
        };
      } catch (error) {
        s.record_error = true;
        s.reason += `;ledger_unavailable:${error instanceof Error ? error.message : "unknown"}`;
      }
      return validateSubmission(s, i.unit_id);
    },
  };
}
