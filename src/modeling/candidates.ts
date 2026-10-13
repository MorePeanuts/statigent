import { integer, keys, obj, str, strings } from "../models/validation";
import { type KnowledgeRef, parseKnowledgeRefs } from "./knowledge";
import type { Score } from "./protocol";

export interface EvidenceUse {
  analysis_id: string;
  source_experiment: string | null;
  refs: string[];
  applicability: string;
}
export type CandidateUpdate = (
  | {
      op: "create";
      id: string;
      hypothesis: string;
      change: string;
      priority: number;
      reason: string;
      evidence: EvidenceUse[];
    }
  | {
      op: "update";
      id: string;
      priority: number | null;
      disposition: "keep" | "defer" | "resume";
      reason: string;
      evidence: EvidenceUse[];
    }
) & { knowledge_refs?: KnowledgeRef[] };
export interface CandidateState {
  id: string;
  hypothesis: string;
  change: string;
  priority: number;
  status: "pending" | "tried" | "deferred";
  reason: string;
  evidence: EvidenceUse[];
  experiment_ids: string[];
  revision: number;
  knowledge_refs?: KnowledgeRef[];
}
export interface CandidateExperiment {
  phase?: "search" | "confirmation" | "final";
  id: string;
  candidate_id: string;
  status: string;
  reason: string;
  rmse?: number | null;
  score?: Score | null;
  final: boolean;
}
export function short(value: unknown, name: string): string {
  const result = str(value, name);
  if (Buffer.byteLength(result) > 8192) throw new Error(`${name} too long`);
  return result;
}
export function identifier(value: unknown): string {
  const result = str(value, "identity");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result))
    throw new Error("Invalid identity");
  return result;
}
export function source(value: unknown): string | null {
  return value === null ? null : identifier(value);
}
export function parseEvidence(value: unknown): EvidenceUse[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("Invalid evidence uses");
  return value.map((value: unknown) => {
    const e = obj(value);
    keys(e, ["analysis_id", "source_experiment", "refs", "applicability"]);
    const refs = strings(e.refs, "refs").map(identifier);
    if (!refs.length || refs.length > 32 || new Set(refs).size !== refs.length)
      throw new Error("Invalid evidence refs");
    return {
      analysis_id: identifier(e.analysis_id),
      source_experiment: source(e.source_experiment),
      refs,
      applicability: short(e.applicability, "applicability"),
    };
  });
}
export function parseCandidateUpdates(
  value: unknown,
  maxCandidates: number,
  knowledgeEnabled = false,
): CandidateUpdate[] {
  integer(maxCandidates, "max candidates");
  if (!Array.isArray(value) || value.length > maxCandidates)
    throw new Error("Invalid candidate update count");
  const ids = new Set<string>();
  return value.map((value: unknown): CandidateUpdate => {
    const c = obj(value);
    const id = identifier(c.id);
    const knowledge =
      knowledgeEnabled && c.knowledge_refs !== undefined
        ? { knowledge_refs: parseKnowledgeRefs(c.knowledge_refs) }
        : {};
    if (ids.has(id)) throw new Error("Duplicate candidate update");
    ids.add(id);
    if (c.op === "create") {
      keys(c, [
        "op",
        "id",
        "hypothesis",
        "change",
        "priority",
        "reason",
        "evidence",
        ...(knowledgeEnabled ? ["knowledge_refs"] : []),
      ]);
      return {
        op: "create",
        id,
        hypothesis: short(c.hypothesis, "hypothesis"),
        change: short(c.change, "change"),
        priority: integer(c.priority, "priority"),
        reason: short(c.reason, "reason"),
        evidence: parseEvidence(c.evidence),
        ...knowledge,
      };
    }
    if (c.op !== "update") throw new Error("Invalid candidate operation");
    keys(c, [
      "op",
      "id",
      "priority",
      "disposition",
      "reason",
      "evidence",
      ...(knowledgeEnabled ? ["knowledge_refs"] : []),
    ]);
    if (
      c.disposition !== "keep" &&
      c.disposition !== "defer" &&
      c.disposition !== "resume"
    )
      throw new Error("Invalid candidate disposition");
    return {
      op: "update",
      id,
      priority: c.priority === null ? null : integer(c.priority, "priority"),
      disposition: c.disposition,
      reason: short(c.reason, "reason"),
      evidence: parseEvidence(c.evidence),
      ...knowledge,
    };
  });
}

/** 返回独立预检结果；后续证据或预算校验失败时直接丢弃，不回滚共享状态。 */
export function applyCandidateUpdates(
  current: readonly CandidateState[],
  updates: readonly CandidateUpdate[],
  maxCandidates: number,
  knowledgeEnabled = false,
): CandidateState[] {
  const parsed = parseCandidateUpdates(
    updates,
    maxCandidates,
    knowledgeEnabled,
  );
  const next = validateCandidateState(current, maxCandidates, knowledgeEnabled);
  for (const update of parsed) {
    const index = next.findIndex((c) => c.id === update.id);
    if (update.op === "create") {
      if (index !== -1) throw new Error("Candidate identity already exists");
      if (next.length >= maxCandidates)
        throw new Error("Candidate limit exhausted");
      const { op: _op, ...definition } = update;
      next.push({
        ...definition,
        status: "pending",
        experiment_ids: [],
        revision: 1,
      });
      continue;
    }
    if (index === -1) throw new Error("Unknown candidate");
    const c = next[index];
    if (!c) throw new Error("Unknown candidate");
    next[index] = {
      ...c,
      priority: update.priority ?? c.priority,
      status:
        update.disposition === "defer"
          ? "deferred"
          : update.disposition === "keep" && c.status === "deferred"
            ? "deferred"
            : c.experiment_ids.length
              ? "tried"
              : "pending",
      reason: update.reason,
      evidence: update.evidence,
      ...(update.knowledge_refs === undefined
        ? {}
        : { knowledge_refs: update.knowledge_refs }),
      revision: integer(c.revision + 1, "revision"),
    };
  }
  return next;
}
export function requireCandidate(
  current: readonly CandidateState[],
  id: string,
  options: { active?: boolean } = {},
): CandidateState {
  const candidate = current.find((c) => c.id === id);
  if (!candidate) throw new Error("Unknown candidate");
  if (options.active && candidate.status === "deferred")
    throw new Error("Candidate is deferred; resume it before execution");
  return candidate;
}
export function attachExperiment(
  current: readonly CandidateState[],
  candidateId: string,
  experimentId: string,
): CandidateState[] {
  identifier(experimentId);
  requireCandidate(current, candidateId);
  if (current.some((c) => c.experiment_ids.includes(experimentId)))
    throw new Error("Experiment already attached");
  return current.map((c) =>
    c.id !== candidateId
      ? structuredClone(c)
      : {
          ...structuredClone(c),
          status: c.status === "deferred" ? "deferred" : "tried",
          experiment_ids: [...c.experiment_ids, experimentId],
          revision: integer(c.revision + 1, "revision"),
        },
  );
}
export function validateRepair(
  experiments: readonly CandidateExperiment[],
  candidateId: string,
  repairId: string | null,
): void {
  if (repairId === null) return;
  identifier(repairId);
  const experiment = experiments.find((e) => e.id === repairId);
  if (
    !experiment ||
    experiment.candidate_id !== candidateId ||
    experiment.final ||
    experiment.status !== "failed"
  )
    throw new Error(
      "Repair requires a confirmed failed search experiment of the same candidate",
    );
}
export function candidateSummary(
  current: readonly CandidateState[],
  experiments: readonly CandidateExperiment[],
) {
  return [...current]
    .sort((a, b) => a.priority - b.priority)
    .map((c) => {
      const last = c.experiment_ids.at(-1);
      const experiment = experiments.find((e) => e.id === last);
      return {
        id: c.id,
        hypothesis: c.hypothesis,
        change: c.change,
        priority: c.priority,
        status: c.status,
        reason: c.reason,
        evidence: c.evidence.map((e) => ({
          analysis_id: e.analysis_id,
          source_experiment: e.source_experiment,
          refs: [...e.refs],
        })),
        revision: c.revision,
        ...(c.knowledge_refs === undefined
          ? {}
          : { knowledge_refs: c.knowledge_refs }),
        attempts: c.experiment_ids.length,
        latest_experiment: last
          ? {
              id: last,
              status: experiment?.status ?? "unconfirmed",
              reason: experiment
                ? experiment.reason.length > 1024
                  ? `${experiment.reason.slice(0, 1024)} [truncated; see experiment record]`
                  : experiment.reason
                : "Execution result not confirmed",
              ...(experiment && "score" in experiment
                ? { score: experiment.score }
                : { rmse: experiment?.rmse ?? null }),
              final: experiment?.final ?? null,
            }
          : null,
      };
    });
}
export function validateCandidateState(
  value: unknown,
  maxCandidates: number,
  knowledgeEnabled = false,
): CandidateState[] {
  integer(maxCandidates, "max candidates");
  if (!Array.isArray(value) || value.length > maxCandidates)
    throw new Error("Invalid candidate count");
  const ids = new Set<string>(),
    experiments = new Set<string>();
  return value.map((value: unknown): CandidateState => {
    const c = obj(value);
    keys(c, [
      "id",
      "hypothesis",
      "change",
      "priority",
      "status",
      "reason",
      "evidence",
      "experiment_ids",
      "revision",
      ...(knowledgeEnabled ? ["knowledge_refs"] : []),
    ]);
    const id = identifier(c.id);
    if (ids.has(id)) throw new Error("Duplicate candidate");
    ids.add(id);
    const experiment_ids = strings(c.experiment_ids, "experiment ids").map(
      identifier,
    );
    for (const experiment of experiment_ids) {
      if (experiments.has(experiment))
        throw new Error("Duplicate experiment attachment");
      experiments.add(experiment);
    }
    if (
      c.status !== "deferred" &&
      c.status !== (experiment_ids.length ? "tried" : "pending")
    )
      throw new Error("Candidate status contradicts execution history");
    return {
      id,
      hypothesis: short(c.hypothesis, "hypothesis"),
      change: short(c.change, "change"),
      priority: integer(c.priority, "priority"),
      status: c.status as CandidateState["status"],
      reason: short(c.reason, "reason"),
      evidence: parseEvidence(c.evidence),
      experiment_ids,
      revision: integer(c.revision, "revision"),
      ...(knowledgeEnabled && c.knowledge_refs !== undefined
        ? { knowledge_refs: parseKnowledgeRefs(c.knowledge_refs) }
        : {}),
    };
  });
}
