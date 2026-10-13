import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { obj } from "../models/validation";
import { reproduce } from "./delivery";
import type { modelingPreflight } from "./preflight";
import { inspectModeling } from "./records";
import type { runModeling } from "./run";
import { validateSmoke, writeSmokeReport } from "./smoke";
export function developmentGoal(goal: string, method: string) {
  return method === "collaborative"
    ? `${goal}\nThis is an explicitly selected development acceptance run: begin with focused data exploration to generate a candidate, train an initial pipeline, use its feedback for a second targeted analysis, revise sourced knowledge and test a follow-up pipeline. Transfer exact prior knowledge revisions into the later analysis. You may defer or reject a suggestion. Predictive improvement is not a passing criterion. Finish explicitly so the host can confirm and deliver.`
    : goal;
}
export async function developmentReport(
  result: Awaited<ReturnType<typeof runModeling>>,
  preflight: Awaited<ReturnType<typeof modelingPreflight>>,
) {
  await writeFile(
    join(result.directory, "preflight.json"),
    JSON.stringify(preflight, null, 2),
    { flag: "wx" },
  );
  let reproduction: unknown = null,
    evidence: unknown = null;
  try {
    if (result.status !== "completed")
      throw new Error(`Run did not complete: ${result.reason}`);
    const view = await inspectModeling(result.directory);
    if (["collaborative", "adaptive_eda"].includes(preflight.task.method))
      evidence = await validateSmoke(result.directory);
    else if (preflight.task.method === "initial_eda") {
      const analyses = view.manifest.analyses;
      if (
        !Array.isArray(analyses) ||
        analyses.length !== 1 ||
        obj(analyses[0]).status !== "completed"
      )
        throw new Error("Initial analysis acceptance failed");
    }
    reproduction = await reproduce(
      result.directory,
      resolve("runs/modeling-reproductions"),
    );
    if (obj(reproduction).status !== "passed")
      throw new Error("Prediction reproduction failed");
    const report = {
      status: "passed",
      run: result,
      method: preflight.task.method,
      resource_version: preflight.task.resource_version,
      evidence,
      reproduction,
      usage: view.manifest.usage,
      confirmation: view.manifest.confirmation,
      search_best: view.manifest.search_best_experiment_id,
      selected: view.manifest.selected_experiment_id,
      external_score: "not_run",
      research_status: "development_only; no claimed benefit",
    };
    await writeSmokeReport(result.directory, report);
    return report;
  } catch (error) {
    const report = {
      status: "failed",
      run: result,
      reason: String(error),
      method: preflight.task.method,
      resource_version: preflight.task.resource_version,
      evidence,
      reproduction,
      research_status: "development failure retained; no automatic retry",
    };
    await writeSmokeReport(result.directory, report);
    return report;
  }
}
