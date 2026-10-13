import { obj, str } from "../models/validation";
import { validateHostAllocation } from "./budget";
export function auditCollaborationV3(
  manifest: Record<string, unknown>,
  events: Record<string, unknown>[],
  actions: Record<string, unknown>[],
) {
  if (
    manifest.schema_version !== 3 ||
    manifest.status !== "completed" ||
    !Array.isArray(manifest.experiments) ||
    !Array.isArray(manifest.analyses)
  )
    throw new Error("Modeling did not complete under schema 3");
  const task = obj(obj(manifest.config).task),
    full = task.method === "collaborative";
  const searches = manifest.experiments
    .map(obj)
    .filter((e) => e.phase === "search" && e.status === "completed");
  if (
    searches.length < 2 ||
    !manifest.experiments
      .map(obj)
      .some((e) => e.phase === "final" && e.status === "completed")
  )
    throw new Error("Missing successful search/follow-up/final training");
  const accepted = events
    .map((event, index) => ({ event, index }))
    .filter((x) => x.event.type === "action_accepted");
  if (accepted.length !== actions.length)
    throw new Error("Missing accepted action payloads");
  const decisions = accepted.map(({ event, index }, i) => {
    if (event.protocol_version !== 3) throw new Error("Wrong action protocol");
    return { event, index, action: obj(actions[i]), intent: obj(event.intent) };
  });
  const analyses = manifest.analyses
    .map(obj)
    .filter((a) => a.status === "completed" && a.dispatch === "started");
  const returned = (id: unknown) =>
    events.findIndex(
      (e) =>
        e.type === "child_result" &&
        e.analysis_id === id &&
        e.status === "completed",
    );
  const diagnosis = analyses.find((a) => {
    const request = obj(a.request),
      sources = Array.isArray(request.source_experiments)
        ? request.source_experiments
        : [];
    const decision = decisions.find((d) => d.intent.analysis_id === a.id),
      end = returned(a.id);
    return (
      sources.length > 0 &&
      decision &&
      sources.every((id) =>
        events.some(
          (e, i) =>
            i < decision.index &&
            e.type === "experiment_result" &&
            e.experiment_id === id &&
            e.status === "completed",
        ),
      ) &&
      end > decision.index &&
      decisions.some(
        (d) =>
          d.index > end &&
          d.action.kind === "train" &&
          searches.some((e) => e.id === d.intent.experiment_id),
      )
    );
  });
  if (!diagnosis)
    throw new Error(
      "Missing completed model diagnosis and subsequent successful search",
    );
  const decision = decisions.find((d) => d.intent.analysis_id === diagnosis.id);
  if (!decision) throw new Error("Missing diagnostic acceptance");
  const allocation = validateHostAllocation(decision.intent.allocation);
  for (const [key, value] of Object.entries(allocation.effective))
    if (obj(diagnosis.effective_budget)[key] !== value)
      throw new Error("Analysis allocation mismatch");
  if (full) {
    if (analyses.length < 2) throw new Error("Missing multi-round analysis");
    const exploration = analyses.find(
      (a) =>
        obj(a.request).purpose === "explore" &&
        returned(a.id) >= 0 &&
        !decisions.some(
          (d) => d.action.kind === "train" && d.index < returned(a.id),
        ) &&
        decisions.some(
          (d) =>
            d.action.kind === "train" &&
            d.index > returned(a.id) &&
            Array.isArray(d.action.candidate_updates) &&
            d.action.candidate_updates.some((c) => obj(c).op === "create"),
        ),
    );
    if (!exploration)
      throw new Error("Missing exploration-generated candidate");
    const history = obj(manifest.knowledge_control).history;
    if (
      !Array.isArray(history) ||
      !history
        .map(obj)
        .some(
          (k) =>
            Number(k.revision) > 1 &&
            history
              .map(obj)
              .some(
                (previous) => previous.id === k.id && previous.revision === 1,
              ) &&
            Array.isArray(k.sources) &&
            k.sources.length > 0,
        )
    )
      throw new Error("Missing sourced knowledge revision");
    if (
      !analyses.some(
        (a) =>
          a.id !== exploration.id &&
          typeof a.context_sha256 === "string" &&
          Array.isArray(obj(a.request).knowledge_refs) &&
          (obj(a.request).knowledge_refs as unknown[]).length > 0,
      )
    )
      throw new Error("Missing explicit later-round knowledge context");
  }
  if (
    obj(task.confirmation).mode !== "none" &&
    obj(manifest.confirmation).status !== "complete"
  )
    throw new Error("Confirmation incomplete");
  const follow = decisions.find(
    (d) =>
      d.index > returned(diagnosis.id) &&
      d.action.kind === "train" &&
      searches.some((e) => e.id === d.intent.experiment_id),
  );
  if (!follow) throw new Error("Missing follow-up");
  return {
    analysis_id: str(diagnosis.id, "analysis ID"),
    analysis_ids: analyses.map((a) => str(a.id, "analysis ID")),
    source_experiment: diagnosis.source_experiment,
    followup_candidate: follow.action.candidate_id,
    followup_experiment: follow.intent.experiment_id,
    evidence_experiment: follow.intent.experiment_id,
    allocation,
    actual_cost: diagnosis.cost,
    mode: full ? "full_collaboration" : "adaptive_tool_use",
    performance_gain: "not_asserted",
  };
}
