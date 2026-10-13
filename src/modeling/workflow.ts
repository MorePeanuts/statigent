import { keys, obj, str } from "../models/validation";
import { sha256 } from "../records/store";
import { identifier, short } from "./candidates";
import type { ModelingMethod } from "./config";
import type { AnalysisRecord } from "./eda";
import type { Experiment } from "./experiments";
import type { BasicProfile } from "./profile";
import { type Protocol, validateScore } from "./protocol";

export const DECISION_INTERFACE = "modeling-decision-v2";
export const CORRECTION_POLICY = "consecutive-unproductive-v2";
export const NOTE_BYTES = 8192;
export const SOURCE_LIMIT = 16;
export type CoreAction =
  | {
      kind: "train";
      code: string;
      change: string;
      reason: string;
      source_experiment: string | null;
      repair_of_experiment: string | null;
    }
  | {
      kind: "analyze";
      question: string;
      purpose: "explore" | "diagnose" | "compare";
      source_experiments: string[];
    }
  | { kind: "finish"; reason: string };
export interface BoundSource {
  source_id: string;
  applicability: string | null;
  binding: Record<string, unknown>;
}
export interface Notes {
  version: 1;
  revision: number;
  sequence: number;
  text: string;
  sources: BoundSource[];
}
export interface AttachmentWarning {
  field: string;
  reason: string;
}
export interface AcceptedAction {
  version: 4;
  core: CoreAction;
  sources: BoundSource[];
  notes: Notes | null;
  warnings: AttachmentWarning[];
}
export interface SourceContext {
  run_id: string;
  profile: BasicProfile;
  profile_sha256: string;
  protocol: Protocol;
  experiments: readonly Experiment[];
  analyses: readonly AnalysisRecord[];
}
export function parseCore(
  name: string,
  raw: unknown,
  codeLimit: number,
  method: ModelingMethod,
): CoreAction {
  const x = obj(raw);
  const nullable = (v: unknown) =>
    v === undefined || v === null ? null : identifier(v);
  if (name === "finish_modeling")
    return { kind: "finish", reason: short(x.reason, "reason") };
  if (name === "analyze") {
    if (method !== "collaborative" && method !== "adaptive_eda")
      throw new Error("Analysis is disabled for this method");
    const sources = x.source_experiments ?? [];
    if (!Array.isArray(sources) || sources.length > 2)
      throw new Error("Invalid analysis sources");
    const ids = sources.map(identifier);
    if (new Set(ids).size !== ids.length)
      throw new Error("Duplicate analysis sources");
    return {
      kind: "analyze",
      question: short(x.question, "question"),
      source_experiments: ids,
      purpose:
        ids.length === 0
          ? "explore"
          : ids.length === 1
            ? "diagnose"
            : "compare",
    };
  }
  if (name !== "run_experiment") throw new Error("Unknown modeling action");
  const code = str(x.code, "code");
  if (Buffer.byteLength(code) > codeLimit)
    throw new Error("Code limit exceeded");
  return {
    kind: "train",
    code,
    change: short(x.change, "change"),
    reason: short(x.reason, "reason"),
    source_experiment: nullable(x.source_experiment),
    repair_of_experiment: nullable(x.repair_of_experiment),
  };
}
export function validateCore(
  core: CoreAction,
  experiments: readonly Experiment[],
) {
  const source = (id: string) => {
    const e = experiments.find((e) => e.id === id);
    if (!e || e.final || e.phase !== "search")
      throw new Error("Unknown confirmed search experiment");
    return e;
  };
  if (core.kind === "train") {
    if (core.source_experiment) source(core.source_experiment);
    if (core.repair_of_experiment) {
      const e = source(core.repair_of_experiment);
      if (e.status !== "failed" || e.score !== null)
        throw new Error("Repair requires a confirmed failed search experiment");
    }
  } else if (core.kind === "analyze") {
    const origins = core.source_experiments.map(source);
    if (
      origins.some(
        (e) => e.status !== "completed" || !e.score || !e.evaluation,
      ) ||
      origins.some(
        (e) =>
          e.evaluation?.evaluation_id !== origins[0]?.evaluation?.evaluation_id,
      )
    )
      throw new Error(
        "Analysis requires successful compatible search experiments",
      );
  } else if (
    !experiments.some(
      (e) =>
        !e.final && e.phase === "search" && e.status === "completed" && e.score,
    )
  )
    throw new Error("Finish requires a successful search experiment");
}
function pointer(value: unknown, path: string) {
  let current = value;
  for (const raw of path.slice(1).split("/")) {
    if (/~(?![01])/u.test(raw)) throw new Error("Invalid profile pointer");
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
      throw new Error("Unknown profile fact");
    current = Reflect.get(current, key);
  }
  return current;
}
export function bindSource(raw: unknown, context: SourceContext): BoundSource {
  const x = obj(raw);
  keys(x, ["source_id", "applicability"]);
  const id = str(x.source_id, "source_id"),
    applicability =
      x.applicability === undefined
        ? null
        : short(x.applicability, "applicability");
  const scope = {
    run_id: context.run_id,
    dataset_sha256: context.profile.identity.train_sha256,
    protocol_sha256: context.protocol.protocol_sha256,
  };
  if (
    context.profile.identity.protocol_sha256 !==
      context.protocol.protocol_sha256 ||
    sha256(Buffer.from(JSON.stringify(context.profile))) !==
      context.profile_sha256
  )
    throw new Error("Source profile identity mismatch");
  let binding: Record<string, unknown>;
  if (id.startsWith("profile:/")) {
    const path = id.slice(8);
    pointer(context.profile, path);
    binding = {
      ...scope,
      kind: "profile",
      profile_sha256: context.profile_sha256,
      path,
    };
  } else {
    const match =
      /^experiment:([A-Za-z0-9_-]{1,128}):(score|failure|train_diagnostic)$/.exec(
        id,
      );
    if (match) {
      const e = context.experiments.find((e) => e.id === match[1]);
      if (
        !e ||
        e.phase !== "search" ||
        !e.evaluation ||
        e.evaluation.protocol_sha256 !== scope.protocol_sha256 ||
        e.evaluation.train_sha256 !== scope.dataset_sha256
      )
        throw new Error("Unknown experiment source");
      const fact = match[2];
      if (fact === "failure") {
        if (e.status !== "failed" || e.score !== null)
          throw new Error("Unconfirmed failure source");
      } else if (fact === "score") {
        if (e.status !== "completed")
          throw new Error("Unconfirmed score source");
        validateScore(e.score, context.protocol, e.evaluation.evaluation_id);
      } else {
        const d = e.training_diagnostic;
        if (
          e.status !== "completed" ||
          !d ||
          d.status !== "available" ||
          d.partition !== "train" ||
          !d.prediction?.output ||
          d.model_sha256 !== e.fit?.output?.sha256 ||
          d.members_sha256 !==
            sha256(Buffer.from(JSON.stringify(e.evaluation.split.train)))
        )
          throw new Error("Training diagnostic source not available");
        validateScore(
          d.score,
          context.protocol,
          sha256(
            Buffer.from(
              JSON.stringify({
                partition: "train",
                search_evaluation_id: e.evaluation.evaluation_id,
                members_sha256: d.members_sha256,
              }),
            ),
          ),
        );
      }
      binding = {
        ...scope,
        kind: "experiment",
        experiment_id: e.id,
        fact,
        evaluation_id: e.evaluation.evaluation_id,
        prediction_sha256:
          fact === "train_diagnostic"
            ? e.training_diagnostic?.prediction?.output?.sha256
            : (e.predict?.output?.sha256 ?? null),
        ...(fact === "train_diagnostic"
          ? {
              partition: "train",
              members_sha256: e.training_diagnostic?.members_sha256,
              model_sha256: e.training_diagnostic?.model_sha256,
            }
          : {}),
      };
    } else {
      const match = /^analysis:([A-Za-z0-9_-]{1,128}):(0|[1-9][0-9]*)$/.exec(
        id,
      );
      const a = match
        ? context.analyses.find((a) => a.id === match[1])
        : undefined;
      const finding = a?.analysis?.findings[Number(match?.[2])];
      if (
        !a ||
        a.status !== "completed" ||
        !a.source_sha256 ||
        !finding ||
        a.dataset_hash !== scope.dataset_sha256 ||
        a.protocol_sha256 !== scope.protocol_sha256
      )
        throw new Error("Unknown or unavailable analysis source");
      for (const origin of a.source_experiments ?? []) {
        const e = context.experiments.find(
          (e) => e.id === origin.experiment_id,
        );
        if (
          !e ||
          e.status !== "completed" ||
          e.phase !== "search" ||
          e.predict?.output?.sha256 !== origin.prediction_sha256
        )
          throw new Error("Analysis prediction source mismatch");
        validateScore(e.score, context.protocol, e.evaluation?.evaluation_id);
      }
      binding = {
        ...scope,
        kind: "analysis",
        analysis_id: a.id,
        finding: Number(match?.[2]),
        evidence_refs: finding.evidence_refs,
        source_sha256: a.source_sha256,
        source_experiments: a.source_experiments ?? [],
      };
    }
  }
  return { source_id: id, applicability, binding };
}
export function acceptAttachments(
  core: CoreAction,
  raw: unknown,
  method: ModelingMethod,
  context: SourceContext,
  previous: Notes | null,
  sequence: number,
): AcceptedAction {
  const x = obj(raw),
    warnings: AttachmentWarning[] = [],
    sources: BoundSource[] = [];
  const warn = (field: string, error: unknown) =>
    warnings.push({ field, reason: String(error) });
  if (x.sources !== undefined) {
    if (!Array.isArray(x.sources) || x.sources.length > SOURCE_LIMIT)
      warn("sources", "Invalid sources or source count");
    else
      for (const [i, raw] of x.sources.entries()) {
        try {
          sources.push(bindSource(raw, context));
        } catch (e) {
          warn(`sources[${i}]`, e);
        }
      }
  }
  let notes: Notes | null = null;
  if (x.notes !== undefined) {
    try {
      if (method !== "collaborative")
        throw new Error("Notes disabled for this method");
      const n = obj(x.notes);
      keys(n, ["text", "sources"]);
      if (typeof n.text !== "string" || Buffer.byteLength(n.text) > NOTE_BYTES)
        throw new Error("Invalid or oversized notes");
      const refs = n.sources ?? [];
      if (!Array.isArray(refs) || refs.length > SOURCE_LIMIT)
        throw new Error("Invalid note sources");
      notes = {
        version: 1,
        revision: (previous?.revision ?? 0) + 1,
        sequence,
        text: n.text,
        sources: refs.map((r) => bindSource(r, context)),
      };
    } catch (e) {
      warn("notes", e);
    }
  }
  return { version: 4, core, sources, notes, warnings };
}
export interface SearchEnd {
  kind: "agent_finished" | "protected" | "failed" | "cancelled";
  reason: string;
}
export function parseSearchEnd(value: unknown): SearchEnd | null {
  if (value === null) return null;
  const x = obj(value);
  keys(x, ["kind", "reason"]);
  if (
    x.kind !== "agent_finished" &&
    x.kind !== "protected" &&
    x.kind !== "failed" &&
    x.kind !== "cancelled"
  )
    throw new Error("Invalid search end kind");
  return { kind: x.kind, reason: str(x.reason, "search end reason") };
}
export function parseDeliveryState(value: unknown) {
  const x = obj(value);
  keys(x, ["status", "artifact"]);
  if (
    x.status !== "not_started" &&
    x.status !== "running" &&
    x.status !== "completed" &&
    x.status !== "failed" &&
    x.status !== "cancelled"
  )
    throw new Error("Invalid delivery status");
  if (
    x.artifact === undefined ||
    (x.status === "completed" && x.artifact === null)
  )
    throw new Error("Missing delivery artifact state");
  if (x.artifact !== null) obj(x.artifact);
  return { status: x.status, artifact: x.artifact };
}
