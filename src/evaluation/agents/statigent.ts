import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Analysis } from "../../agent/actions";
import {
  ROLE_PROMPT_VERSIONS,
  ROLE_PROMPTS,
} from "../../agent/collaboration-prompt";
import { DEFAULT_BUDGET, validateOrganization } from "../../agent/config";
import {
  PROMPT_VERSION,
  REPORT_PROMPT_VERSION,
  SYSTEM_PROMPT,
} from "../../agent/prompt";
import { type RunOptions, runAgent } from "../../agent/run";
import {
  SCRIPT_PROMPT_VERSION,
  SCRIPT_ROLE_PROMPTS,
  SCRIPT_ROLE_VERSIONS,
  SCRIPT_SYSTEM_PROMPT,
} from "../../agent/script-prompt";
import { validateBackend } from "../../execution/backend";
import { validateImageBackend } from "../../execution/docker";
import { resolveCredential } from "../../models/config";
import { integer, keys, obj, str } from "../../models/validation";
import { executionMetadata } from "../../records/execution-metadata";
import { resolveImageReference } from "../../records/markdown";
import {
  inspectModelJournal,
  readArtifact,
  readManifest,
  sha256,
} from "../../records/store";
import {
  type AgentAdapter,
  emptyUsage,
  type Submission,
  validateInvocation,
  validateSubmission,
} from "../contracts";
import { inspectImage } from "./docker";
import { buildTrajectory, COLLABORATION_MAPPING } from "./trajectory";

/** Deliverable name of the unified trajectory; report files must end in .md, so it cannot collide. */
const TRAJECTORY_FILE = "trajectory.txt";

/**
 * Copies the accepted report and only the images it references. References stay as the model wrote them,
 * so the report resolves inside the deliverables directory without rewriting.
 */
export async function deliverReport(
  runDirectory: string,
  analysis: Analysis | null,
  reportFile: string,
  deliverablesRoot: string,
): Promise<void> {
  const report = analysis?.report;
  if (!report)
    throw new Error("Completed report task without an accepted report");
  const artifacts = (await readManifest(runDirectory)).artifacts;
  const copy = async (artifactId: string, target: string) => {
    const ref = artifacts.find((a) => a.artifact_id === artifactId);
    if (!ref) throw new Error(`Missing artifact ${artifactId}`);
    const destination = join(deliverablesRoot, target);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, await readArtifact(runDirectory, ref), {
      flag: "wx",
      mode: 0o600,
    });
  };
  await copy(report.artifact_id, reportFile);
  for (const image of report.images)
    await copy(
      image.artifact_id,
      resolveImageReference(reportFile, image.reference),
    );
}
export function statigentAdapter(
  dependencies: {
    run?: typeof runAgent;
    overrides?: Partial<RunOptions>;
    image?: typeof inspectImage;
  } = {},
): AgentAdapter {
  const options = (value: unknown) => {
    const x = obj(value);
    keys(x, ["image", "organization", "budget", "backend"]);
    const overrides = obj(x.budget ?? {});
    // Unified task/batch budgets own these three limits. Native options cannot increase them.
    const {
      model_attempts: _a,
      total_tokens: _t,
      task_timeout_ms: _m,
      ...budget
    } = DEFAULT_BUDGET;
    keys(overrides, Object.keys(budget));
    for (const key of Object.keys(overrides) as (keyof typeof budget)[])
      budget[key] = integer(
        overrides[key],
        key,
        ["rate_retries", "code_repairs", "action_corrections"].includes(key)
          ? 0
          : 1,
      );
    return {
      image: str(x.image, "image"),
      organization: validateOrganization(x.organization),
      backend: validateBackend(x.backend),
      budget,
    };
  };
  return {
    id: "statigent-eda",
    version: "3",
    capabilities: {
      schema_version: 2,
      outputs: ["text", "report"],
      trajectory: "unified",
      model: "configurable",
      seed: "execution",
      isolation: "docker",
      model_budget: true,
      usage: "measured",
    },
    options,
    async preview(config) {
      const settings = options(config.options);
      if (settings.backend === "fresh-script") {
        const image = await (dependencies.image ?? inspectImage)(
          settings.image,
        );
        validateImageBackend(settings.backend, image.runtime_labels);
      }
    },
    async preflight(config) {
      if (!config.model) throw new Error("Model profile required");
      if (!dependencies.overrides?.client) resolveCredential(config.model);
      const settings = options(config.options);
      const image = await (dependencies.image ?? inspectImage)(settings.image);
      validateImageBackend(settings.backend, image.runtime_labels);
      const script = settings.backend === "fresh-script";
      const roleVersions = script ? SCRIPT_ROLE_VERSIONS : ROLE_PROMPT_VERSIONS;
      const rolePrompts = script ? SCRIPT_ROLE_PROMPTS : ROLE_PROMPTS;
      const version = script ? SCRIPT_PROMPT_VERSION : PROMPT_VERSION;
      return {
        ...image,
        execution: executionMetadata(settings.backend),
        ...(settings.organization === "planner-executor"
          ? {
              role_prompts: Object.fromEntries(
                (["planner", "executor"] as const).map((role) => [
                  role,
                  {
                    version: roleVersions[role],
                    sha256: sha256(Buffer.from(rolePrompts[role])),
                  },
                ]),
              ),
              trajectory_mapping: script
                ? "fresh-script-planner-executor-v1"
                : COLLABORATION_MAPPING,
            }
          : {
              trajectory_mapping: script
                ? "fresh-script-single-v1"
                : "single-v1",
              prompt: {
                version,
                report_version: `${version}+${REPORT_PROMPT_VERSION}`,
                sha256: sha256(
                  Buffer.from(script ? SCRIPT_SYSTEM_PROMPT : SYSTEM_PROMPT),
                ),
              },
            }),
        role: settings.organization,
        native_budget: settings.budget,
        unified_budget_source: "invocation.effective_budget",
        backend: settings.backend,
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
      const output = i.task.output;
      const settings = options(i.config.options);
      const result = await (dependencies.run ?? runAgent)({
        ...dependencies.overrides,
        profile,
        task: {
          organization: settings.organization,
          backend: settings.backend,
          goal: i.task.goal,
          constraints: [
            ...i.task.constraints,
            ...(output.kind === "report"
              ? [
                  `Report requirements: ${output.instructions}`,
                  "Put a short summary in analysis.summary; the report file is the deliverable.",
                ]
              : [
                  `Final answer format: ${output.instructions}`,
                  "Place the final answer exactly in analysis.summary; put evidence, methods and limitations in the other fields.",
                ]),
          ],
          ...(output.kind === "report"
            ? {
                report: {
                  image_types: output.image_types,
                  max_images: output.max_images,
                  max_image_bytes: output.max_image_bytes,
                  max_report_bytes: output.max_report_bytes,
                },
              }
            : {}),
          model_profile: profile.id,
          execution: {
            image: settings.image,
            input_root: i.input_root,
            inputs: i.task.inputs.map((f) => f.path),
            seed: i.seed,
          },
          budget: {
            ...settings.budget,
            model_attempts: i.budget.model_attempts,
            total_tokens: i.budget.total_tokens,
            task_timeout_ms: i.budget.timeout_ms,
          },
        },
        runRoot: i.run_root,
        signal,
      });
      const s: Submission = {
        schema_version: 2,
        unit_id: i.unit_id,
        status: result.status,
        reason: result.reason,
        answer_text: result.analysis?.summary ?? "",
        deliverables: [],
        trajectory: null,
        native_run: { id: result.run_id, directory: result.directory },
        usage: emptyUsage("unknown"),
        record_error: result.record_error,
        cleanup_error: result.reason.includes("cleanup") ? result.reason : null,
      };
      if (output.kind === "report" && s.status === "completed")
        try {
          await deliverReport(
            result.directory,
            result.analysis,
            output.report_file,
            i.deliverables_root,
          );
        } catch (error) {
          s.status = "failed";
          s.reason = `report_delivery_failed:${error instanceof Error ? error.message : String(error)}`;
        }
      if (i.trajectory)
        try {
          const reportPath =
            output.kind === "report"
              ? join(i.deliverables_root, output.report_file)
              : null;
          const report =
            reportPath && (await Bun.file(reportPath).exists())
              ? await Bun.file(reportPath).text()
              : (result.analysis?.summary ?? null);
          const secret = process.env[profile.api_key_env];
          await writeFile(
            join(i.deliverables_root, TRAJECTORY_FILE),
            await buildTrajectory(result.directory, report, [
              ...(secret ? [secret] : []),
              result.directory,
              i.run_root,
              i.input_root,
              i.deliverables_root,
              process.cwd(),
              homedir(),
            ]),
            { flag: "wx", mode: 0o600 },
          );
          s.trajectory = TRAJECTORY_FILE;
        } catch (error) {
          s.status = "failed";
          s.reason += `;trajectory_failed:${error instanceof Error ? error.message : String(error)}`;
        }
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
      return validateSubmission(s, i.unit_id, { frozen: false });
    },
  };
}
