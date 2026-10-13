import { join } from "node:path";
import { inspectImage } from "../evaluation/agents/docker";
import { dockerCommand, validateImageBackend } from "../execution/docker";
import { obj } from "../models/validation";
import { buildScripts } from "../records/script-journal";
import { verifyScriptExport } from "../records/scripts";
import {
  readArtifact,
  readEvents,
  readManifest,
  writeJson,
} from "../records/store";
import { validateAnalysis } from "./actions";
import { loadConfiguration } from "./cli";
import { returnedImages, validatePlannerReport } from "./collaboration-report";
import { preflightInputs, validateOrganization } from "./config";
import { resolveReport } from "./report";
import { type AgentResult, runAgent } from "./run";
export async function loadScriptSmoke(args: string[]) {
  const preflight = args.includes("--preflight");
  const values = args.filter((a) => a !== "--preflight");
  if (
    args.filter((a) => a === "--preflight").length > 1 ||
    values.length !== 2 ||
    values[0] !== "--organization"
  )
    throw Error(
      "Usage: bun run test:smoke:script --organization single|planner-executor [--preflight]",
    );
  const organization = validateOrganization(values[1]);
  const config = await loadConfiguration(
    [
      "--task",
      "configs/tasks/fresh-script-report.json",
      "--model",
      "deepseek-flash",
      "--runs",
      "runs/script-smoke",
    ],
    true,
  );
  config.task.organization = organization;
  return { ...config, preflight };
}
export async function checkScriptSmoke(result: AgentResult) {
  const manifest = await readManifest(result.directory);
  const events = await readEvents(result.directory);
  if (
    result.status !== "completed" ||
    manifest.status !== "completed" ||
    manifest.execution?.backend !== "fresh-script" ||
    !result.analysis?.report
  )
    throw Error("Completed fresh-script report required");
  const view = buildScripts(events),
    success = view.scripts.filter(
      (s) => s.status === "ok" && s.result?.persistence_complete === true,
    );
  if (
    success.length < 2 ||
    new Set(success.map((s) => obj(s.result?.process).instance_id)).size !==
      success.length
  )
    throw Error("Distinct successful processes required");
  const writer = success.findIndex((s) =>
    /\.to_csv\(["']middle\.csv["']/.test(s.code),
  );
  const reader = success.findIndex(
    (s, i) => i > writer && /\.read_csv\(["']middle\.csv["']/.test(s.code),
  );
  if (writer < 0 || reader < 0)
    throw Error(
      "Missing explicit middle.csv write/read witness in separate scripts",
    );
  if (
    manifest.collaboration &&
    success[writer]?.subtask_id === success[reader]?.subtask_id
  )
    throw Error("Cross-delegation file reuse required");
  const snapshot = manifest.artifacts.find(
    (a) =>
      a.source_path === "middle.csv" &&
      a.execution_id === success[writer]?.execution_id,
  );
  if (
    !snapshot ||
    !/(?:^|\n)A,2(?:\.0)?\r?\n/.test(
      (await readArtifact(result.directory, snapshot)).toString(),
    ) ||
    !/(?:^|\n)B,4(?:\.0)?(?:\r?\n|$)/.test(
      (await readArtifact(result.directory, snapshot)).toString(),
    )
  )
    throw Error("Saved CSV does not contain expected means");
  const evidence = new Set(
    manifest.collaboration
      ? manifest.collaboration.subtasks.flatMap((s) => s.evidence_refs)
      : [
          ...success.map((s) => s.execution_id),
          ...manifest.artifacts
            .filter((a) => a.complete)
            .map((a) => a.artifact_id),
        ],
  );
  const analysis = validateAnalysis(obj(result.analysis), evidence);
  if (
    !analysis.findings.some((f) => {
      const value = f.value;
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const means = obj(obj(value).group_means ?? {});
      return means.A === 2 && means.B === 4;
    })
  )
    throw Error("Expected group_means missing");
  const config = await loadScriptSmoke([
    "--organization",
    manifest.collaboration ? "planner-executor" : "single",
  ]);
  const spec = config.task.report;
  if (!spec) throw Error("Missing report spec");
  const report = result.analysis.report;
  if (manifest.collaboration) {
    const ref = manifest.artifacts.find(
      (a) => a.artifact_id === report.artifact_id,
    );
    if (ref?.origin?.role !== "planner")
      throw Error("Planner report origin required");
    const descriptors = await returnedImages(
      result.directory,
      manifest.artifacts,
      [...evidence],
    );
    await validatePlannerReport(
      (await readArtifact(result.directory, ref)).toString(),
      result.directory,
      manifest.artifacts,
      new Map(descriptors.map((d) => [d.reference, d])),
      spec,
    );
  } else
    await resolveReport(
      result.directory,
      manifest.artifacts,
      report.artifact_id,
      spec,
    );
  if (!report.images.length) throw Error("Report chart required");
  await verifyScriptExport(result.directory, manifest);
  if (
    manifest.tokens === "not_applicable" ||
    manifest.tokens.status !== "known" ||
    manifest.tokens.total_tokens <= 0
  )
    throw Error("Measured usage required");
  if (
    await dockerCommand([
      "ps",
      "-aq",
      "--filter",
      `label=org.statigent.run=${result.run_id}`,
    ])
  )
    throw Error("Container remains");
  return {
    status: "passed",
    run_id: result.run_id,
    organization: config.task.organization,
    backend: "fresh-script",
    successful_scripts: success.length,
    file_witness: {
      writer: success[writer]?.execution_id,
      reader: success[reader]?.execution_id,
      path: "middle.csv",
    },
    tokens: manifest.tokens,
  };
}
export async function scriptSmokeMain(
  args: string[],
  dependencies: {
    run?: typeof runAgent;
    image?: typeof inspectImage;
    check?: typeof checkScriptSmoke;
  } = {},
) {
  const { preflight, ...config } = await loadScriptSmoke(args);
  await preflightInputs(config.task);
  const image = await (dependencies.image ?? inspectImage)(
    config.task.execution.image,
  );
  validateImageBackend("fresh-script", image.runtime_labels);
  if (preflight)
    return {
      status: "preflight_passed",
      organization: config.task.organization,
      backend: config.task.backend,
      budget: config.task.budget,
      model: config.profile.model,
      model_calls: 0,
      image,
    };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let result: AgentResult;
  try {
    result = await (dependencies.run ?? runAgent)({
      ...config,
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  try {
    const accepted = await (dependencies.check ?? checkScriptSmoke)(result);
    await writeJson(join(result.directory, "smoke-result.json"), accepted);
    return accepted;
  } catch (error) {
    await writeJson(join(result.directory, "smoke-result.json"), {
      status: "failed",
      run_id: result.run_id,
      reason: String(error),
    });
    throw error;
  }
}
if (import.meta.main)
  scriptSmokeMain(Bun.argv.slice(2))
    .then((x) => console.log(JSON.stringify(x, null, 2)))
    .catch((e) => {
      console.error(String(e));
      process.exitCode = 1;
    });
