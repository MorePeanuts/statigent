import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { regular } from "../evaluation/files";
import { obj, str } from "../models/validation";
import { reproduce } from "./delivery";
import type { modelingPreflight } from "./preflight";
import { inspectModeling } from "./records";
import type { runModeling } from "./run";
import { writeSmokeReport } from "./smoke";
import { workflowTrajectory } from "./trajectory";
export function developmentGoal(goal: string, _method: string) {
  return goal;
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
    trajectory: unknown = null,
    usage: unknown = null;
  try {
    const view = await inspectModeling(result.directory),
      actions: Record<string, unknown>[] = [];
    for (const e of view.events.filter((e) => e.type === "action_accepted"))
      actions.push(
        obj(
          JSON.parse(
            await readFile(
              await regular(
                result.directory,
                str(obj(e.content_ref).path, "payload"),
              ),
              "utf8",
            ),
          ),
        ),
      );
    trajectory = workflowTrajectory(view.manifest, view.events, actions);
    usage = view.manifest.usage;
    if (result.status !== "completed")
      throw new Error(`Run did not complete: ${result.reason}`);
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
      trajectory,
      reproduction,
      usage,
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
      trajectory,
      reproduction,
      usage,
      research_status: "development failure retained; no automatic retry",
    };
    await writeSmokeReport(result.directory, report);
    return report;
  }
}
