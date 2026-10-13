import { obj } from "../models/validation";
import { parseDeliveryState, parseSearchEnd } from "./workflow";

/** Called after journal validation; describes observed behavior without prescribing it. */
export function workflowTrajectory(
  manifest: Record<string, unknown>,
  events: Record<string, unknown>[],
  payloads: Record<string, unknown>[],
) {
  if (manifest.schema_version !== 4)
    throw new Error("Expected workflow record v4");
  const search = parseSearchEnd(manifest.search_end),
    delivery = parseDeliveryState(manifest.delivery);
  const decisions = events.filter((e) => e.type === "action_accepted");
  if (decisions.length !== payloads.length)
    throw new Error("Missing accepted actions");
  const analyses = Array.isArray(manifest.analyses)
    ? manifest.analyses.map(obj)
    : [];
  const experiments = Array.isArray(manifest.experiments)
    ? manifest.experiments.map(obj)
    : [];
  const actions = decisions.map((event, i) => ({
    event,
    accepted: obj(obj(payloads[i]).accepted),
  }));
  const links = actions.flatMap(({ event, accepted }) => {
    if (obj(accepted.core).kind !== "train") return [];
    const refs = Array.isArray(accepted.sources)
      ? accepted.sources.map(obj)
      : [];
    return refs.flatMap((ref) => {
      const binding = obj(ref.binding),
        analysis = analyses.find(
          (a) => a.id === binding.analysis_id && a.status === "completed",
        );
      const experiment = experiments.find(
        (e) =>
          e.id === obj(event.intent).experiment_id && e.status === "completed",
      );
      return binding.kind === "analysis" && analysis && experiment
        ? [
            {
              analysis_id: analysis.id,
              experiment_id: experiment.id,
              source_experiments: analysis.source_experiments,
            },
          ]
        : [];
    });
  });
  const followups = analyses
    .filter((a) => a.status === "completed")
    .flatMap((a) => {
      const returned = events.find(
        (e) => e.type === "child_result" && e.analysis_id === a.id,
      );
      const next = actions.find(
        ({ event, accepted }) =>
          obj(accepted.core).kind === "train" &&
          Number(event.sequence) > Number(returned?.sequence) &&
          experiments.some(
            (e) =>
              e.id === obj(event.intent).experiment_id &&
              e.status === "completed",
          ),
      );
      return next
        ? [
            {
              analysis_id: a.id,
              experiment_id: obj(next.event.intent).experiment_id,
            },
          ]
        : [];
    });
  return {
    search_end: search,
    delivery_status: delivery.status,
    completion:
      delivery.status === "completed"
        ? search?.kind === "agent_finished"
          ? "autonomous"
          : "protected"
        : "incomplete",
    accounting: obj(obj(manifest.usage).tokens).status,
    collaboration: followups.length ? "covered" : "not_covered",
    analysis_calls: analyses.length,
    successful_analyses: analyses.filter((a) => a.status === "completed")
      .length,
    // Order shows that the loop ran; explicit references separately show declared provenance.
    analysis_followups: followups,
    analysis_experiment_links: links,
    analysis_ids: [...new Set(links.map((l) => String(l.analysis_id)))],
    core_rejections: events
      .filter((e) => e.type === "action_rejected")
      .map((e) => ({ sequence: e.sequence, reason: e.reason })),
    attachment_warnings: actions.flatMap(({ event, accepted }) =>
      (Array.isArray(accepted.warnings) ? accepted.warnings : []).map((w) => ({
        sequence: event.sequence,
        ...obj(w),
      })),
    ),
    unproductive_executions: [
      ...experiments.filter(
        (e) => e.phase === "search" && e.status !== "completed",
      ),
      ...analyses.filter((a) => a.status !== "completed"),
    ].map((e) => ({ id: e.id, status: e.status, reason: e.reason })),
    protection_reason: search?.kind === "protected" ? search.reason : null,
  };
}
