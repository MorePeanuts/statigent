import type { Analysis } from "../agent/actions";
import { sha256 } from "../records/store";
import type { CandidateState } from "./candidates";
import type { AnalysisRecord } from "./eda";
import {
  type KnowledgeRevision,
  type KnowledgeUpdate,
  parseKnowledgeUpdates,
  requireKnowledge,
} from "./knowledge";
import type { BasicProfile } from "./profile";
import { type Protocol, type Score, validateScore } from "./protocol";

export interface KnowledgeFacts {
  scope: KnowledgeRevision["scope"];
  profile: BasicProfile;
  profile_sha256: string;
  protocol: Protocol;
  analyses: readonly {
    id: string;
    scope: KnowledgeRevision["scope"];
    status: string;
    analysis: Analysis | null;
    source_sha256: string;
    sources: { experiment_id: string; prediction_sha256: string }[];
  }[];
  experiments: readonly {
    id: string;
    scope: KnowledgeRevision["scope"];
    status: string;
    phase: "search" | "confirmation" | "final";
    score: Score | null;
    prediction_sha256: string | null;
    reason: string;
  }[];
}
/** Hints expose only already accepted findings; they never upgrade failed EDA. */
export function analysisSourceHints(
  a: Pick<AnalysisRecord, "id" | "status" | "analysis" | "source_sha256">,
) {
  if (a.status !== "completed" || !a.analysis || !a.source_sha256) return [];
  const sourceHash = a.source_sha256;
  return a.analysis.findings.map((finding, index) => ({
    kind: "analysis" as const,
    analysis_id: a.id,
    finding: index,
    evidence_refs: [...finding.evidence_refs],
    source_sha256: sourceHash,
    applicability:
      "Explain how this finding on the supplied training data and source experiments applies to your candidate.",
  }));
}
function sameScope(
  a: KnowledgeRevision["scope"],
  b: KnowledgeRevision["scope"],
) {
  return (
    a.run_id === b.run_id &&
    a.dataset_sha256 === b.dataset_sha256 &&
    a.protocol_sha256 === b.protocol_sha256
  );
}
function pointerExists(value: unknown, path: string) {
  let current = value;
  for (const raw of path.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    )
      return false;
    current = Reflect.get(current, key);
  }
  return true;
}
export function validateKnowledgeSources(
  updates: readonly KnowledgeUpdate[],
  facts: KnowledgeFacts,
) {
  if (
    facts.scope.protocol_sha256 !== facts.protocol.protocol_sha256 ||
    facts.profile.identity.protocol_sha256 !== facts.scope.protocol_sha256 ||
    facts.profile.identity.train_sha256 !== facts.scope.dataset_sha256 ||
    sha256(Buffer.from(JSON.stringify(facts.profile))) !== facts.profile_sha256
  )
    throw new Error("Knowledge task/profile identity mismatch");
  for (const update of parseKnowledgeUpdates(updates))
    for (const ref of update.sources) {
      if (ref.kind === "profile") {
        if (
          ref.profile_sha256 !== facts.profile_sha256 ||
          !pointerExists(facts.profile, ref.path)
        )
          throw new Error(
            `Unknown profile fact for ${update.id}: use the current basic_profile_sha256 and an existing JSON pointer relative to basic_profile, such as /rows or /columns/0/missing`,
          );
      } else if (ref.kind === "experiment") {
        const experiment = facts.experiments.find(
          (e) => e.id === ref.experiment_id,
        );
        if (
          !experiment ||
          !sameScope(experiment.scope, facts.scope) ||
          experiment.phase !== "search"
        )
          throw new Error("Unknown experiment fact");
        if (ref.fact === "score") {
          if (experiment.status !== "completed")
            throw new Error("Unconfirmed experiment score");
          validateScore(experiment.score, facts.protocol);
        } else if (
          experiment.status !== "failed" ||
          !experiment.reason ||
          experiment.score !== null
        )
          throw new Error("Unconfirmed experiment failure");
      } else {
        const analysis = facts.analyses.find((a) => a.id === ref.analysis_id);
        if (
          !analysis ||
          !sameScope(analysis.scope, facts.scope) ||
          analysis.status !== "completed" ||
          !analysis.analysis ||
          analysis.source_sha256 !== ref.source_sha256
        )
          throw new Error("Unconfirmed analysis source");
        const finding = analysis.analysis.findings[ref.finding];
        if (
          !finding ||
          ref.evidence_refs.some((r) => !finding.evidence_refs.includes(r))
        )
          throw new Error(
            `Unknown finding evidence for ${update.id}, analysis ${ref.analysis_id}, finding ${ref.finding}; valid refs for this finding: ${JSON.stringify(finding?.evidence_refs ?? [])}. Do not move evidence from another finding; use a separate source with its actual finding index.`,
          );
        for (const source of analysis.sources) {
          const experiment = facts.experiments.find(
            (e) => e.id === source.experiment_id,
          );
          if (
            !experiment ||
            !sameScope(experiment.scope, facts.scope) ||
            experiment.phase !== "search" ||
            experiment.status !== "completed" ||
            !source.prediction_sha256 ||
            experiment.prediction_sha256 !== source.prediction_sha256
          )
            throw new Error("Analysis prediction provenance mismatch");
          validateScore(experiment.score, facts.protocol);
        }
      }
    }
}
export function validateKnowledgeLinks(
  history: readonly KnowledgeRevision[],
  candidates: readonly CandidateState[],
) {
  for (const revision of history)
    for (const id of revision.candidate_ids)
      if (!candidates.some((c) => c.id === id))
        throw new Error("Unknown related candidate");
  for (const candidate of candidates)
    for (const ref of candidate.knowledge_refs ?? [])
      requireKnowledge(history, ref);
}
