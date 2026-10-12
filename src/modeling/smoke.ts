import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import config from "../../configs/modeling/dsbench-s3e9.json";
import selection from "../../configs/modeling/dsbench-s3e9-selection.json";
import { regular, verifyFiles } from "../evaluation/files";
import { selectProfile } from "../models/config";
import { obj, str } from "../models/validation";
import { readManifest, writeJson } from "../records/store";
import { loadDataset } from "./data";
import { reproduce, scoreDelivery } from "./delivery";
import { inspectModeling } from "./records";
import { runModeling } from "./run";
export function auditCollaboration(
  manifest: Record<string, unknown>,
  events: Record<string, unknown>[],
  actions: Record<string, unknown>[],
) {
  if (
    manifest.status !== "completed" ||
    !Array.isArray(manifest.experiments) ||
    !Array.isArray(manifest.analyses)
  )
    throw new Error("Modeling did not complete");
  const experiments = manifest.experiments.map(obj),
    analyses = manifest.analyses.map(obj);
  const searches = experiments.filter(
    (e) => e.final === false && e.status === "completed",
  );
  if (
    searches.length < 2 ||
    !experiments.some((e) => e.final === true && e.status === "completed")
  )
    throw new Error("Missing successful initial/follow-up/final training");
  const analysis = analyses.find(
    (a) =>
      a.status === "completed" &&
      searches.some((e) => e.id === a.source_experiment),
  );
  if (!analysis) throw new Error("No completed model-directed EDA");
  const linked = actions.find(
    (a) =>
      a.kind === "train" &&
      Array.isArray(a.evidence) &&
      a.evidence.some((v) => obj(v).analysis_id === analysis.id) &&
      searches.some(
        (e) =>
          e.candidate_id === a.candidate_id &&
          e.id !== analysis.source_experiment,
      ),
  );
  if (
    !linked ||
    !searches.some(
      (e) =>
        e.candidate_id === linked.candidate_id &&
        e.id !== analysis.source_experiment,
    )
  )
    throw new Error("No evidence-linked follow-up training");
  const initial = events.findIndex(
    (e) =>
      e.type === "experiment_result" &&
      e.experiment_id === analysis.source_experiment &&
      e.status === "completed",
  );
  const returned = events.findIndex(
    (e) =>
      e.type === "child_result" &&
      e.analysis_id === analysis.id &&
      e.status === "completed",
  );
  const follow = events.findIndex(
    (e, index) =>
      index > returned &&
      e.type === "experiment_intent" &&
      e.candidate_id === linked.candidate_id &&
      e.final === false,
  );
  if (initial < 0 || returned <= initial || follow <= returned)
    throw new Error("Invalid collaboration order");
  return {
    analysis_id: analysis.id,
    source_experiment: analysis.source_experiment,
    followup_candidate: linked.candidate_id,
  };
}
export async function validateSmoke(directory: string) {
  const view = await inspectModeling(directory),
    actions: Record<string, unknown>[] = [];
  for (const event of view.events.filter((e) => e.type === "action_accepted")) {
    const ref = obj(event.content_ref);
    actions.push(
      obj(
        JSON.parse(
          await readFile(
            await regular(directory, str(ref.path, "payload")),
            "utf8",
          ),
        ),
      ),
    );
  }
  const evidence = auditCollaboration(view.manifest, view.events, actions);
  const analyses = view.manifest.analyses;
  if (!Array.isArray(analyses)) throw new Error("Missing analyses");
  for (const raw of analyses) {
    const a = obj(raw),
      native = await readManifest(str(a.directory, "EDA directory"));
    if (
      native.run_id !== a.run_id ||
      !native.collaboration ||
      native.collaboration.roles.planner.tokens.attempts < 1 ||
      native.collaboration.roles.executor.tokens.attempts < 1
    )
      throw new Error("EDA did not execute both roles");
  }
  if (view.unconfirmed_children.length)
    throw new Error("Unconfirmed child operations");
  return evidence;
}
export async function modelingSmoke() {
  await verifyFiles(resolve(selection.source_root), selection.sources);
  const dataset = await loadDataset(resolve(config.dataset_root));
  if (JSON.stringify(dataset.dataset) !== JSON.stringify(selection.dataset))
    throw new Error("Frozen development dataset mismatch");
  const models: unknown = await Bun.file("configs/models.json").json();
  const profile = selectProfile(models, config.model_profile);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let result: Awaited<ReturnType<typeof runModeling>>;
  try {
    result = await runModeling({
      task: config,
      profile,
      edaProfile: profile,
      runRoot: resolve("runs/modeling-smoke"),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  try {
    const evidence = await validateSmoke(result.directory);
    const replay = await reproduce(
      result.directory,
      resolve("runs/modeling-reproductions"),
    );
    if (replay.status !== "passed")
      throw new Error(`Prediction reproduction ${replay.reason}`);
    const score = await scoreDelivery(
      result.directory,
      resolve("benchmarks/dsbench/modeling/private/playground-series-s3e9"),
      "test_answer.csv",
      resolve("runs/modeling-scores"),
    );
    const report = {
      status: "passed",
      run: result,
      evidence,
      reproduction: replay.directory,
      score,
    };
    await writeJson(join(result.directory, "smoke-result.json"), report);
    return report;
  } catch (error) {
    const report = { status: "failed", run: result, reason: String(error) };
    await writeJson(join(result.directory, "smoke-result.json"), report);
    return report;
  }
}
if (import.meta.main)
  modelingSmoke()
    .then((x) => {
      console.log(JSON.stringify(x, null, 2));
      if (x.status !== "passed") process.exitCode = 1;
    })
    .catch((e) => {
      console.error(String(e));
      process.exitCode = 1;
    });
