import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateAnalysis } from "../agent/actions";
import { regular, verifyFiles } from "../evaluation/files";
import { integer, keys, obj, str, strings } from "../models/validation";
import { readManifest, sha256 } from "../records/store";
import { action } from "./actions-v3";
import { applyCandidateUpdates, type CandidateState } from "./candidates";
import { validateRecordedModelingTask } from "./config";
import { datasetProtocol, validateDataset } from "./data";
import {
  applyKnowledgeUpdates,
  type KnowledgeRevision,
  requireKnowledge,
} from "./knowledge";
import {
  type KnowledgeFacts,
  validateKnowledgeLinks,
  validateKnowledgeSources,
} from "./knowledge-sources";
import { validateBasicProfile } from "./profile";
import { validateScore } from "./protocol";

function list(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Expected records");
  return value.map(obj);
}
function same(a: unknown, b: unknown) {
  if (!isDeepStrictEqual(a, b))
    throw new Error("Knowledge snapshot/source mismatch");
}
export async function inspectKnowledge(
  directory: string,
  manifest: Record<string, unknown>,
  events: Record<string, unknown>[],
  payloads: Map<number, unknown>,
) {
  if (manifest.schema_version !== 3) return "not_recorded" as const;
  const config = obj(manifest.config),
    task = validateRecordedModelingTask(config.task),
    dataset = validateDataset(config.dataset),
    protocol = datasetProtocol(dataset);
  const profileEvents = events.filter(
    (e) => e.type === "basic_profile_completed",
  );
  if (manifest.basic_profile === null) {
    if (profileEvents.length || events.some((e) => e.type === "model_request"))
      throw new Error("Missing profile before search");
    if (task.method !== "collaborative") {
      same(manifest.knowledge_control, "disabled");
      return "disabled" as const;
    }
    same(manifest.knowledge_control, {
      version: 1,
      history: [],
      applied_sequence: 0,
    });
    return { version: 1, history: [], applied_sequence: 0 };
  }
  const saved = obj(manifest.basic_profile),
    artifact = obj(saved.artifact);
  const path = str(artifact.path, "profile path");
  if (path !== "basic-profile/profile.json")
    throw new Error("Invalid profile path");
  await verifyFiles(directory, [
    {
      path,
      bytes: integer(artifact.bytes, "profile bytes"),
      sha256: str(artifact.sha256, "profile hash"),
    },
  ]);
  const profile = validateBasicProfile(
    JSON.parse(await readFile(await regular(directory, path), "utf8")),
    dataset,
  );
  same(saved.profile, profile);
  if (
    profileEvents.length !== 1 ||
    events.some(
      (e) =>
        e.type === "model_request" &&
        Number(e.sequence) < Number(profileEvents[0]?.sequence),
    )
  )
    throw new Error("Invalid profile acceptance order");
  same(profileEvents[0]?.artifact, artifact);
  if (task.method !== "collaborative") {
    same(manifest.knowledge_control, "disabled");
    return "disabled" as const;
  }
  const control = obj(manifest.knowledge_control);
  keys(control, ["version", "history", "applied_sequence"]);
  if (control.version !== 1)
    throw new Error("Unknown knowledge control version");
  const position = integer(control.applied_sequence, "knowledge position", 0);
  same(position, obj(manifest.candidate_control).applied_sequence);
  const scope = {
    run_id: str(manifest.run_id, "run ID"),
    dataset_sha256: dataset.files[0]?.sha256 ?? "",
    protocol_sha256: protocol.protocol_sha256,
  };
  const experiments = list(manifest.experiments),
    analyses = list(manifest.analyses);
  const facts: KnowledgeFacts = {
    scope,
    profile,
    profile_sha256: str(artifact.sha256, "profile hash"),
    protocol,
    experiments: [],
    analyses: [],
  };
  let history: KnowledgeRevision[] = [],
    candidates: CandidateState[] = [],
    matched = position === 0;
  if (!position) same(control.history, history);
  for (const event of events) {
    const seq = integer(event.sequence, "sequence");
    if (event.type === "experiment_result") {
      const e = experiments.find((e) => e.id === event.experiment_id);
      if (!e) continue; // A failed save may leave a confirmed journal result absent from the snapshot.
      if (facts.experiments.some((x) => x.id === e.id))
        throw new Error("Duplicate knowledge experiment fact");
      const status = str(e.status, "experiment status");
      facts.experiments = [
        ...facts.experiments,
        {
          id: str(e.id, "experiment ID"),
          scope,
          status,
          phase:
            e.phase === "confirmation"
              ? "confirmation"
              : e.final
                ? "final"
                : "search",
          reason: str(e.reason, "reason"),
          score: e.score === null ? null : validateScore(e.score, protocol),
          prediction_sha256:
            e.predict && obj(e.predict).output
              ? str(obj(obj(e.predict).output).sha256, "prediction hash")
              : null,
        },
      ];
    } else if (
      event.type === "child_result" &&
      event.analysis_id !== undefined
    ) {
      const a = analyses.find((a) => a.id === event.analysis_id);
      if (!a || a.status !== "completed") continue;
      if (facts.analyses.some((x) => x.id === a.id))
        throw new Error("Duplicate knowledge analysis fact");
      const sourcePath = join(
        `${str(a.id, "analysis ID")}-input`,
        "source.json",
      );
      const bytes = await readFile(await regular(directory, sourcePath));
      same(sha256(bytes), a.source_sha256);
      const context = await readFile(
        await regular(
          directory,
          join(`${str(a.id, "analysis ID")}-input`, "context.json"),
        ),
      );
      same(sha256(context), a.context_sha256);
      const childRoot = str(a.directory, "analysis directory"),
        child = await readManifest(childRoot);
      if (!child.agent || child.agent === "not_applicable")
        throw new Error("Missing native analysis result");
      const nativeResult = await readFile(
        await regular(
          childRoot,
          str(child.agent.final_result, "analysis result path"),
        ),
        "utf8",
      );
      const { run_id, ...nativeAnalysis } = obj(JSON.parse(nativeResult));
      same(run_id, a.run_id);
      same(nativeAnalysis, a.analysis);
      const source = obj(JSON.parse(bytes.toString()));
      same(source.protocol, protocol);
      same(source.data, dataset.files[0]);
      same(source.split_sha256, dataset.split.sha256);
      const sources = list(source.sources).map((s) => ({
        experiment_id: str(s.experiment_id, "source experiment"),
        prediction_sha256: str(s.prediction_sha256, "prediction hash"),
      }));
      same(sources, a.source_experiments);
      const raw = obj(a.analysis),
        refs = new Set(
          list(raw.findings).flatMap((f) => strings(f.evidence_refs, "refs")),
        );
      facts.analyses = [
        ...facts.analyses,
        {
          id: str(a.id, "analysis ID"),
          scope,
          status: "completed",
          analysis: validateAnalysis(raw, refs),
          source_sha256: str(a.source_sha256, "source hash"),
          sources,
        },
      ];
    } else if (event.type === "action_accepted") {
      if (event.protocol_version !== 3)
        throw new Error("Unknown knowledge action protocol");
      const { kind, ...parameters } = obj(payloads.get(seq));
      const selected = action(
        kind === "train"
          ? "run_experiment"
          : kind === "analyze"
            ? "analyze"
            : kind === "finish"
              ? "finish_modeling"
              : "invalid",
        JSON.stringify(parameters),
        task.limits.max_code_bytes,
        task.budget.max_candidates,
        task.method,
      );
      candidates = applyCandidateUpdates(
        candidates,
        selected.candidate_updates,
        task.budget.max_candidates,
        true,
      );
      validateKnowledgeSources(selected.knowledge_updates ?? [], facts);
      history = applyKnowledgeUpdates(
        history,
        selected.knowledge_updates ?? [],
        scope,
        seq,
      );
      validateKnowledgeLinks(history, candidates);
      for (const ref of selected.knowledge_refs ?? [])
        requireKnowledge(history, ref);
    }
    if (seq === position) {
      same(control.history, history);
      matched = true;
    }
  }
  if (!matched) throw new Error("Knowledge snapshot is not in journal");
  return { version: 1, history, applied_sequence: position };
}
