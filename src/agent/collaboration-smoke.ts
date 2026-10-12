import { join } from "node:path";
import { obj } from "../models/validation";
import {
  readArtifact,
  readEvents,
  readManifest,
  writeJson,
} from "../records/store";
import { validateAnalysis } from "./actions";
import { loadConfiguration } from "./cli";
import { returnedImages, validatePlannerReport } from "./collaboration-report";
import { validateTask } from "./config";
import { type AgentResult, runAgent } from "./run";
import { checkSyntheticRun } from "./smoke";

/** Acceptance over immutable evidence. It verifies this fixed synthetic task, not arbitrary analysis quality. */
export async function checkCollaborationEvidence(result: AgentResult) {
  const manifest = await readManifest(result.directory);
  const collaboration = manifest.collaboration;
  if (
    result.status !== "completed" ||
    manifest.status !== "completed" ||
    !collaboration ||
    !result.analysis?.report
  )
    throw new Error("Completed dual report required");
  const subtasks = collaboration.subtasks.filter(
    (s) => s.status === "completed",
  );
  if (subtasks.length < 2)
    throw new Error("Two completed delegations required");
  const evidence = new Set(
    collaboration.subtasks.flatMap((s) => s.evidence_refs),
  );
  const analysis = validateAnalysis(obj(result.analysis), evidence);
  const values = analysis.findings.map((f) =>
    f.value && typeof f.value === "object" && !Array.isArray(f.value)
      ? obj(f.value)
      : {},
  );
  if (
    !values.some((v) => {
      const means = obj(v.group_means ?? {});
      return means.A === 2 && means.B === 4;
    }) ||
    !values.some(
      (v) =>
        Array.isArray(v.centered_values) &&
        v.centered_values.length === 2 &&
        v.centered_values[0] === -2 &&
        v.centered_values[1] === 2,
    )
  )
    throw new Error("Missing expected group_means/centered_values");
  const events = await readEvents(result.directory);
  const successful = new Set(
    events
      .filter((e) => e.type === "finish" && obj(e.result).status === "ok")
      .map((e) => String(obj(e.result).cell_id)),
  );
  const cells = events
    .filter(
      (e) =>
        e.type === "dispatch" &&
        e.role === "executor" &&
        successful.has(String(obj(e.request).cell_id)),
    )
    .map((e) => ({
      code: String(obj(e.request).code),
      cell_id: String(obj(e.request).cell_id),
      subtask_id: e.subtask_id,
    }));
  if (new Set(cells.map((c) => c.subtask_id)).size < 2)
    throw new Error("Successful cells from two delegations required");
  const process = Bun.spawn(
    [
      "uv",
      "run",
      "--frozen",
      "python",
      join(
        import.meta.dir,
        "../../python/statigent_runtime/smoke_dependencies.py",
      ),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  process.stdin.write(JSON.stringify(cells));
  process.stdin.end();
  const timer = setTimeout(() => process.kill(), 30000);
  let witnesses: unknown;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) throw new Error(`State witness check failed: ${stderr}`);
    witnesses = JSON.parse(stdout);
    if (!Array.isArray(witnesses) || !witnesses.length)
      throw new Error("No cross-delegation data binding observed");
  } finally {
    clearTimeout(timer);
  }
  const spec = validateTask(
    await Bun.file("configs/tasks/collaboration-report.json").json(),
  ).report;
  if (!spec) throw new Error("Missing smoke report specification");
  const report = result.analysis.report;
  const ref = manifest.artifacts.find(
    (a) => a.artifact_id === report.artifact_id,
  );
  if (!ref || ref.origin?.role !== "planner" || ref.cell_id)
    throw new Error("Report must originate from planner");
  const descriptors = await returnedImages(
    result.directory,
    manifest.artifacts,
    [...evidence],
  );
  const markdown = (await readArtifact(result.directory, ref)).toString("utf8");
  const images = await validatePlannerReport(
    markdown,
    result.directory,
    manifest.artifacts,
    new Map(descriptors.map((d) => [d.reference, d])),
    spec,
  );
  if (
    !images.length ||
    JSON.stringify(images) !== JSON.stringify(report.images)
  )
    throw new Error("Report images mismatch or missing");
  return {
    status: "passed",
    run_id: result.run_id,
    completed_subtasks: subtasks.length,
    state_witnesses: witnesses,
    report_artifact_id: ref.artifact_id,
    images: images.length,
    roles: collaboration.roles,
    tokens: manifest.tokens,
    code: manifest.code,
  };
}

export function loadCollaborationSmokeConfiguration() {
  return loadConfiguration(
    [
      "--task",
      "configs/tasks/collaboration-report.json",
      "--model",
      "deepseek-flash",
      "--runs",
      "runs/collaboration-smoke",
    ],
    true,
  );
}
export async function collaborationSmokeMain(args: string[]) {
  if (args.length)
    throw new Error(
      "Fixed smoke takes no arguments; edit/review the committed task for a different experiment",
    );
  const config = await loadCollaborationSmokeConfiguration();
  console.log(
    JSON.stringify({
      kind: "explicit_collaboration_smoke",
      model: config.profile.model,
      organization: config.task.organization,
      budget: config.task.budget,
    }),
  );
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let result: AgentResult;
  try {
    result = await runAgent({ ...config, signal: controller.signal });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  console.log(JSON.stringify(result));
  try {
    await checkSyntheticRun(result);
    const acceptance = await checkCollaborationEvidence(result);
    await writeJson(join(result.directory, "smoke-result.json"), acceptance);
    return acceptance;
  } catch (error) {
    await writeJson(join(result.directory, "smoke-result.json"), {
      status: "failed",
      run_id: result.run_id,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
if (import.meta.main)
  collaborationSmokeMain(Bun.argv.slice(2))
    .then((value) => console.log(JSON.stringify(value, null, 2)))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
