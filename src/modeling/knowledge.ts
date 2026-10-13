import { integer, keys, obj, strings } from "../models/validation";
import { identifier, short } from "./candidates";

export type KnowledgeKind = "observation" | "hypothesis" | "question";
export type KnowledgeStatus =
  | "active"
  | "open"
  | "supported"
  | "challenged"
  | "resolved"
  | "withdrawn";
export interface KnowledgeRef {
  id: string;
  revision: number;
}
export type KnowledgeSource =
  | { kind: "profile"; profile_sha256: string; path: string }
  | {
      kind: "analysis";
      analysis_id: string;
      finding: number;
      evidence_refs: string[];
      source_sha256: string;
      applicability: string;
    }
  | { kind: "experiment"; experiment_id: string; fact: "score" | "failure" };
export interface KnowledgeUpdate {
  op: "create" | "revise";
  id: string;
  kind: KnowledgeKind;
  base_revision: number | null;
  statement: string;
  status: KnowledgeStatus;
  reason: string;
  sources: KnowledgeSource[];
  candidate_ids: string[];
}
export interface KnowledgeRevision
  extends Omit<KnowledgeUpdate, "op" | "base_revision"> {
  revision: number;
  previous_revision: number | null;
  accepted_sequence: number;
  scope: { run_id: string; dataset_sha256: string; protocol_sha256: string };
}
export const KNOWLEDGE_STATUSES: Record<
  KnowledgeKind,
  readonly KnowledgeStatus[]
> = {
  observation: ["active", "withdrawn"],
  hypothesis: ["open", "supported", "challenged", "withdrawn"],
  question: ["open", "resolved", "withdrawn"],
};
function hash(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid knowledge source hash");
  return value;
}
export function parseKnowledgeRefs(value: unknown): KnowledgeRef[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Invalid knowledge references");
  const ids = new Set<string>();
  return value.map((v: unknown) => {
    const x = obj(v);
    keys(x, ["id", "revision"]);
    const id = identifier(x.id);
    if (ids.has(id)) throw new Error("Duplicate knowledge reference");
    ids.add(id);
    return { id, revision: integer(x.revision, "knowledge revision") };
  });
}
export function parseKnowledgeSources(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("Invalid knowledge sources");
  return value.map((v: unknown): KnowledgeSource => {
    const x = obj(v);
    if (x.kind === "profile") {
      keys(x, ["kind", "profile_sha256", "path"]);
      const path = short(x.path, "profile pointer");
      if (
        !path.startsWith("/") ||
        path.includes("..") ||
        /~(?![01])/.test(path)
      )
        throw new Error(
          "Invalid profile pointer: use a JSON pointer within basic_profile, e.g. /rows or /columns/0/missing; do not use basic_profile as a path or remove an observation's source",
        );
      return { kind: "profile", profile_sha256: hash(x.profile_sha256), path };
    }
    if (x.kind === "analysis") {
      keys(x, [
        "kind",
        "analysis_id",
        "finding",
        "evidence_refs",
        "source_sha256",
        "applicability",
      ]);
      const refs = strings(x.evidence_refs, "evidence refs").map(identifier);
      if (
        !refs.length ||
        refs.length > 32 ||
        new Set(refs).size !== refs.length
      )
        throw new Error("Invalid knowledge evidence refs");
      return {
        kind: "analysis",
        analysis_id: identifier(x.analysis_id),
        finding: integer(x.finding, "finding index", 0),
        evidence_refs: refs,
        source_sha256: hash(x.source_sha256),
        applicability: short(x.applicability, "applicability"),
      };
    }
    if (x.kind !== "experiment")
      throw new Error("Invalid knowledge source kind");
    keys(x, ["kind", "experiment_id", "fact"]);
    if (x.fact !== "score" && x.fact !== "failure")
      throw new Error("Invalid experiment fact");
    return {
      kind: "experiment",
      experiment_id: identifier(x.experiment_id),
      fact: x.fact,
    };
  });
}
export function parseKnowledgeUpdates(value: unknown): KnowledgeUpdate[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Invalid knowledge updates");
  const ids = new Set<string>();
  return value.map((v: unknown): KnowledgeUpdate => {
    const x = obj(v);
    keys(x, [
      "op",
      "id",
      "kind",
      "base_revision",
      "statement",
      "status",
      "reason",
      "sources",
      "candidate_ids",
    ]);
    const id = identifier(x.id);
    if (ids.has(id)) throw new Error("Duplicate knowledge update");
    ids.add(id);
    if (x.op !== "create" && x.op !== "revise")
      throw new Error("Invalid knowledge operation");
    if (
      x.kind !== "observation" &&
      x.kind !== "hypothesis" &&
      x.kind !== "question"
    )
      throw new Error("Invalid knowledge kind");
    if (!KNOWLEDGE_STATUSES[x.kind].some((s) => s === x.status))
      throw new Error(
        `Invalid knowledge status for ${id} (${x.kind}): ${String(x.status)}; allowed: ${KNOWLEDGE_STATUSES[x.kind].join(", ")}`,
      );
    const base_revision =
      x.op === "create" ? null : integer(x.base_revision, "base revision");
    if (x.op === "create" && x.base_revision !== null)
      throw new Error("New knowledge has no base revision");
    const sources = parseKnowledgeSources(x.sources),
      candidate_ids = strings(x.candidate_ids, "candidate IDs").map(identifier);
    if (
      candidate_ids.length > 64 ||
      new Set(candidate_ids).size !== candidate_ids.length
    )
      throw new Error("Invalid related candidates");
    if (x.kind === "observation" && !sources.length)
      throw new Error(
        `Observation requires a source: ${id}; cite a valid profile pointer, completed analysis finding or confirmed experiment. Otherwise omit this optional update; never fabricate a source.`,
      );
    if (
      x.status === "supported" &&
      !sources.some((s) => s.kind === "experiment" && s.fact === "score")
    )
      throw new Error(
        "Supported hypothesis requires a successful experiment reference",
      );
    return {
      op: x.op,
      id,
      kind: x.kind,
      base_revision,
      statement: short(x.statement, "statement"),
      status: x.status as KnowledgeStatus,
      reason: short(x.reason, "reason"),
      sources,
      candidate_ids,
    };
  });
}
export function requireKnowledge(
  history: readonly KnowledgeRevision[],
  ref: KnowledgeRef,
) {
  const entry = history.find(
    (x) => x.id === ref.id && x.revision === ref.revision,
  );
  if (!entry) throw new Error("Unknown knowledge revision");
  return entry;
}
/** Append immutable revisions to a private preview; the caller persists acceptance before adopting it. */
export function applyKnowledgeUpdates(
  history: readonly KnowledgeRevision[],
  updates: unknown,
  scope: KnowledgeRevision["scope"],
  sequence: number,
): KnowledgeRevision[] {
  identifier(scope.run_id);
  hash(scope.dataset_sha256);
  hash(scope.protocol_sha256);
  integer(sequence, "acceptance sequence");
  const parsed = parseKnowledgeUpdates(updates),
    next = structuredClone([...history]);
  for (const update of parsed) {
    const previous = [...history].reverse().find((x) => x.id === update.id);
    if (
      update.op === "create"
        ? Boolean(previous)
        : !previous || previous.revision !== update.base_revision
    )
      throw new Error("Duplicate identity or stale knowledge revision");
    if (
      previous &&
      (previous.kind !== update.kind ||
        JSON.stringify(previous.scope) !== JSON.stringify(scope))
    )
      throw new Error("Knowledge identity/scope cannot change");
    if (history.some((x) => x.accepted_sequence >= sequence))
      throw new Error("Non-monotonic knowledge acceptance");
    if (next.length >= 1024) throw new Error("Knowledge history limit");
    const { op: _op, base_revision, ...entry } = update;
    next.push({
      ...entry,
      previous_revision: base_revision,
      revision: (previous?.revision ?? 0) + 1,
      accepted_sequence: sequence,
      scope: structuredClone(scope),
    });
  }
  return next;
}
