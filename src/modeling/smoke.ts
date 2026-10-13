import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import config from "../../configs/modeling/dsbench-s3e9.json";
import selection from "../../configs/modeling/dsbench-s3e9-selection.json";
import { regular, verifyFiles } from "../evaluation/files";
import { selectProfile } from "../models/config";
import { obj, str } from "../models/validation";
import { readManifest } from "../records/store";
import { requestedBudget, validateAllocation } from "./budget";
import { loadDataset } from "./data";
import { reproduce, scoreDelivery } from "./delivery";
import { inspectModeling } from "./records";
import { runModeling } from "./run";
/** inspectModeling validates the journal first; this adds functional smoke criteria. */
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
  if (obj(manifest.candidate_control).version !== 1)
    throw new Error("Missing candidate control");
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
  const accepted = events.flatMap((event, index) =>
    event.type === "action_accepted" ? [{ event, index }] : [],
  );
  if (accepted.length !== actions.length)
    throw new Error("Missing accepted action payload");
  const decisions = accepted.map(({ event, index }, i) => {
    if (event.protocol_version !== 2)
      throw new Error("Missing current action protocol");
    return { event, index, action: obj(actions[i]), intent: obj(event.intent) };
  });
  const qualifyingAnalyses = analyses.filter(
    (a) =>
      a.status === "completed" &&
      searches.some((e) => e.id === a.source_experiment),
  );
  if (!qualifyingAnalyses.length)
    throw new Error("No completed model-directed EDA");
  for (const analysis of qualifyingAnalyses) {
    const allocationDecision = decisions.find(
      (d) =>
        d.action.kind === "analyze" &&
        d.intent.analysis_id === analysis.id &&
        d.intent.child_id === analysis.run_id,
    );
    if (!allocationDecision) throw new Error("Missing EDA allocation decision");
    const allocation = validateAllocation(allocationDecision.intent.allocation);
    if (
      JSON.stringify(
        requestedBudget(allocationDecision.action.requested_budget),
      ) !== JSON.stringify(allocation.requested)
    )
      throw new Error("EDA requested budget mismatch");
    str(allocationDecision.action.budget_reason, "EDA budget reason");
    const childBudget = obj(analysis.effective_budget);
    for (const [key, value] of Object.entries(allocation.effective))
      if (childBudget[key] !== value)
        throw new Error("EDA effective budget was not applied");
    if (analysis.dispatch !== "started")
      throw new Error("EDA was not dispatched");
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
    if (
      initial < 0 ||
      allocationDecision.index <= initial ||
      returned <= allocationDecision.index
    )
      throw new Error("Invalid collaboration order");
    const usesAnalysis = (evidence: unknown) =>
      Array.isArray(evidence) &&
      evidence.some((raw) => obj(raw).analysis_id === analysis.id);
    for (const experiment of searches.filter(
      (e) => e.id !== analysis.source_experiment,
    )) {
      const follow = decisions.find(
        (d) =>
          d.action.kind === "train" && d.intent.experiment_id === experiment.id,
      );
      if (
        !follow ||
        follow.index <= returned ||
        follow.action.candidate_id !== experiment.candidate_id
      )
        continue;
      const intentPosition = events.findIndex(
        (e, i) =>
          i > follow.index &&
          e.type === "experiment_intent" &&
          e.experiment_id === experiment.id &&
          e.candidate_id === experiment.candidate_id &&
          e.final === false,
      );
      const resultPosition = events.findIndex(
        (e, i) =>
          i > intentPosition &&
          e.type === "experiment_result" &&
          e.experiment_id === experiment.id &&
          e.status === "completed",
      );
      if (intentPosition < 0 || resultPosition < 0) continue;
      let current = follow;
      const visited = new Set<unknown>();
      let linked = false;
      while (!visited.has(current.intent.experiment_id)) {
        visited.add(current.intent.experiment_id);
        if (usesAnalysis(current.action.evidence)) {
          linked = true;
          break;
        }
        const repaired = experiments.find(
          (e) =>
            e.id === current.action.repair_of_experiment &&
            e.candidate_id === experiment.candidate_id &&
            e.final === false &&
            e.status === "failed",
        );
        const prior =
          repaired &&
          decisions.find(
            (d) =>
              d.intent.experiment_id === repaired.id &&
              d.action.kind === "train" &&
              d.action.candidate_id === experiment.candidate_id &&
              d.index > returned &&
              d.index < current.index,
          );
        if (!prior) break;
        current = prior;
      }
      if (!linked) continue;
      const updated = decisions.some(
        (d) =>
          d.index > returned &&
          d.index <= follow.index &&
          Array.isArray(d.action.candidate_updates) &&
          d.action.candidate_updates.some((raw) => {
            const update = obj(raw);
            return (
              (update.op === "create" || update.op === "update") &&
              usesAnalysis(update.evidence)
            );
          }),
      );
      if (!updated) continue;
      return {
        analysis_id: analysis.id,
        source_experiment: analysis.source_experiment,
        followup_candidate: experiment.candidate_id,
        followup_experiment: experiment.id,
        evidence_experiment: current.intent.experiment_id,
        allocation,
        actual_cost: analysis.cost,
      };
    }
  }
  throw new Error(
    "No evidence-linked follow-up training with accepted candidate updates and experiment order",
  );
}
/** A later offline review must use a different report; never rewrite the first result. */
export async function writeSmokeReport(directory: string, report: unknown) {
  await writeFile(
    join(directory, "smoke-result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" },
  );
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
  for (const raw of analyses.filter(
    (a) => obj(a).id === evidence.analysis_id,
  )) {
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
    await writeSmokeReport(result.directory, report);
    return report;
  } catch (error) {
    const report = { status: "failed", run: result, reason: String(error) };
    await writeSmokeReport(result.directory, report);
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
