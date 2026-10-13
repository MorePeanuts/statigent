import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { regular } from "../evaluation/files";
import { integer, keys, obj, str } from "../models/validation";
import { readManifest, sha256, writeJson } from "../records/store";
import {
  type ModelingAction as NewAction,
  action as newAction,
} from "./actions";
import {
  ledger,
  roleLedgers,
  validateAllocation,
  validateHostAllocation,
} from "./budget";
import {
  applyCandidateUpdates,
  attachExperiment,
  type CandidateExperiment,
  type CandidateState,
  type EvidenceUse,
  requireCandidate,
  validateCandidateState,
  validateRepair,
} from "./candidates";
import { validateModelingTask } from "./config";
import { datasetProtocol, validateDataset } from "./data";
import { inspectKnowledge } from "./knowledge-records";
import { action, type ModelingAction as LegacyAction } from "./legacy-actions";

type ModelingAction = LegacyAction | NewAction;

import {
  better,
  type Score,
  validateProtocol,
  validateScore,
} from "./protocol";
export class ModelingRecord {
  private failed = false;
  private bytes = 0;
  private sequence = 0;
  get nextSequence() {
    return this.sequence + 1;
  }
  private constructor(
    readonly directory: string,
    readonly id: string,
    readonly maxBytes: number,
    readonly header: Record<string, unknown>,
  ) {}
  static async create(
    root: string,
    config: Record<string, unknown>,
    maxBytes: number,
    id = randomUUID(),
  ) {
    await mkdir(resolve(root), { recursive: true });
    const dir = resolve(root, id);
    await mkdir(dir);
    await mkdir(join(dir, "payloads"));
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"]),
      dirty = Bun.spawnSync(["git", "status", "--porcelain"]);
    const header = {
      schema_version:
        obj(config.task ?? {}).schema_version === 2
          ? 3
          : config.protocol === undefined
            ? 1
            : 2,
      kind: "modeling",
      run_id: id,
      started_at: new Date().toISOString(),
      config,
      code: {
        commit: commit.exitCode === 0 ? commit.stdout.toString().trim() : null,
        dirty: dirty.exitCode === 0 ? Boolean(dirty.stdout.length) : null,
      },
      environment: {
        os: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? null,
        logical_cpus: cpus().length,
        memory_bytes: totalmem(),
        bun: Bun.version,
      },
    };
    const r = new ModelingRecord(dir, id, maxBytes, header);
    await r.save({ status: "running" });
    return r;
  }
  async event(
    type: string,
    fields: Record<string, unknown> = {},
    content?: unknown,
  ) {
    if (this.failed) throw new Error("record_failure");
    try {
      const event: Record<string, unknown> = {
        ...fields,
        type,
        run_id: this.id,
        at: new Date().toISOString(),
        sequence: ++this.sequence,
      };
      if (content !== undefined) {
        const bytes = Buffer.from(JSON.stringify(content));
        this.bytes += bytes.length;
        if (this.bytes > this.maxBytes) throw new Error("trace_size_limit");
        const path = `payloads/${this.sequence}.json`;
        await writeFile(join(this.directory, path), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        event.content_ref = {
          path,
          sha256: sha256(bytes),
          bytes: bytes.length,
        };
      }
      const line = `${JSON.stringify(event)}\n`;
      this.bytes += Buffer.byteLength(line);
      if (this.bytes > this.maxBytes) throw new Error("trace_size_limit");
      const handle = await open(join(this.directory, "events.jsonl"), "a");
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return this.sequence;
    } catch (e) {
      this.failed = true;
      throw new Error(`record_failure:${String(e)}`);
    }
  }
  async save(fields: Record<string, unknown>) {
    if (this.failed) throw new Error("record_failure");
    try {
      await writeJson(join(this.directory, "modeling.json"), {
        ...this.header,
        ...fields,
      });
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
}
export async function inspectModeling(directory: string) {
  const path = await regular(directory, "modeling.json");
  if ((await stat(path)).size > 32 * 1024 ** 2)
    throw new Error("Manifest too large");
  const manifest = obj(JSON.parse(await readFile(path, "utf8")));
  if (
    ![1, 2, 3].includes(Number(manifest.schema_version)) ||
    manifest.kind !== "modeling"
  )
    throw new Error("Unsupported modeling record");
  if (
    manifest.schema_version === 1 &&
    obj(manifest.config).protocol !== undefined
  )
    throw new Error("Legacy record cannot contain a v2 task protocol");
  if (manifest.schema_version === 2 || manifest.schema_version === 3) {
    const config = obj(manifest.config),
      data = validateDataset(config.dataset),
      protocol = validateProtocol(config.protocol, data.id_column);
    if (protocol.protocol_sha256 !== datasetProtocol(data).protocol_sha256)
      throw new Error("Record task protocol mismatch");
    if (manifest.candidate_control === undefined)
      throw new Error("Missing candidate control");
  }
  str(manifest.run_id, "run ID");
  str(manifest.status, "status");
  const eventPath = await regular(directory, "events.jsonl");
  if ((await stat(eventPath)).size > 64 * 1024 ** 2)
    throw new Error("Events too large");
  const events = (await readFile(eventPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => obj(JSON.parse(line)));
  const payloads = new Map<number, unknown>();
  for (const [i, e] of events.entries()) {
    if (
      e.run_id !== manifest.run_id ||
      integer(e.sequence, "sequence") !== i + 1
    )
      throw new Error("Event identity mismatch");
    str(e.type, "event type");
    if (e.content_ref) {
      const ref = obj(e.content_ref),
        p = str(ref.path, "payload path");
      if (!/^payloads\/\d+\.json$/.test(p))
        throw new Error("Invalid payload path");
      const data = await readFile(await regular(directory, p));
      if (data.length !== ref.bytes || sha256(data) !== ref.sha256)
        throw new Error("Payload integrity mismatch");
      payloads.set(i + 1, JSON.parse(data.toString()));
      if (
        e.type === "model_context" &&
        (e.version !== 1 || e.sha256 !== ref.sha256 || e.bytes !== ref.bytes)
      )
        throw new Error("Model visible context identity mismatch");
    }
  }
  const completed = new Set(
    events.filter((e) => e.type === "child_result").map((e) => e.child_id),
  );
  const control = await inspectControl(directory, manifest, events, payloads);
  const children = events.filter((e) => e.type === "child_intent");
  // 接受记录已持久化而独立派发事件尚未写入时，仍可定位可能未完成的工作。
  for (const e of control.accepted_children)
    if (!children.some((child) => child.child_id === e.child_id))
      children.push(e);
  return {
    manifest,
    events,
    candidate_control: control.view,
    knowledge_control: await inspectKnowledge(
      directory,
      manifest,
      events,
      payloads,
    ),
    unconfirmed_experiments: control.unconfirmed_experiments,
    unconfirmed_children: children.filter((e) => !completed.has(e.child_id)),
  };
}

function same(actual: unknown, expected: unknown, label: string) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected)))
    throw new Error(`${label} mismatch`);
}
function objects(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value.map(obj);
}
function evidence(
  uses: EvidenceUse[],
  analyses: Record<string, unknown>[],
  confirmed: Set<string>,
  dataset: unknown,
) {
  for (const use of uses) {
    const a = analyses.find((a) => a.id === use.analysis_id);
    if (
      !a ||
      !confirmed.has(use.analysis_id) ||
      a.status !== "completed" ||
      a.source_experiment !== use.source_experiment ||
      !a.analysis
    )
      throw new Error("Candidate evidence provenance mismatch");
    const data = obj(dataset);
    const files = objects(data.files, "dataset files");
    if (
      a.dataset_hash !== files[0]?.sha256 ||
      a.split_hash !== obj(data.split).sha256
    )
      throw new Error("Candidate evidence dataset mismatch");
    const refs = objects(obj(a.analysis).findings, "findings").flatMap((f) => {
      if (!Array.isArray(f.evidence_refs))
        throw new Error("Invalid evidence references");
      return f.evidence_refs;
    });
    if (use.refs.some((ref) => !refs.includes(ref)))
      throw new Error("Unknown candidate evidence reference");
  }
}
async function inspectControl(
  directory: string,
  manifest: Record<string, unknown>,
  events: Record<string, unknown>[],
  payloads: Map<number, unknown>,
) {
  const none = {
    view: "not_recorded" as const,
    accepted_children: [] as Record<string, unknown>[],
    unconfirmed_experiments: [] as Record<string, unknown>[],
  };
  if (manifest.candidate_control === undefined) {
    const prompt = obj(manifest.config).prompt;
    if (
      (prompt && obj(prompt).version === "modeling-v2") ||
      events.some((e) => e.protocol_version === 2)
    )
      throw new Error("Missing candidate control extension");
    return none;
  }
  const config = obj(manifest.config);
  const protocol =
    manifest.schema_version === 2 || manifest.schema_version === 3
      ? validateProtocol(
          config.protocol,
          validateDataset(config.dataset).id_column,
        )
      : null;
  const scoreOf = (e: CandidateExperiment): Score | null =>
    protocol
      ? e.score
        ? validateScore(e.score, protocol)
        : null
      : e.rmse === null || e.rmse === undefined
        ? null
        : {
            metric: "rmse",
            direction: "minimize",
            value: e.rmse,
            protocol_sha256: "legacy",
            scoring_version: "legacy",
          };
  const bestResult = () => {
    let best: CandidateExperiment | undefined;
    let score: Score | null = null;
    for (const e of results.values()) {
      const s = scoreOf(e);
      if (e.status === "completed" && !e.final && s && better(s, score)) {
        best = e;
        score = s;
      }
    }
    return best;
  };
  const extension = obj(manifest.candidate_control);
  keys(extension, ["version", "candidates", "applied_sequence"]);
  if (extension.version !== 1)
    throw new Error("Unsupported candidate control version");
  const task = obj(obj(manifest.config).task),
    budget = obj(task.budget),
    limits = obj(task.limits);
  const max = integer(budget.max_candidates, "max candidates"),
    position = integer(extension.applied_sequence, "applied sequence", 0);
  if (position > events.length)
    throw new Error("Candidate snapshot sequence beyond journal");
  const modern = manifest.schema_version === 3;
  const method = modern ? validateModelingTask(task).method : null;
  const snapshot = validateCandidateState(
    extension.candidates,
    max,
    method === "collaborative",
  );
  const experiments = objects(manifest.experiments ?? [], "experiments"),
    analyses = objects(manifest.analyses ?? [], "analyses");
  const accepted = new Map<
    number,
    { action: ModelingAction; intent: Record<string, unknown> }
  >();
  const intents = new Map<string, Record<string, unknown>>(),
    results = new Map<string, CandidateExperiment>();
  const acceptedChildren: Record<string, unknown>[] = [],
    confirmedAnalyses = new Set<string>();
  const histories: Record<string, unknown>[] = [];
  let current: CandidateState[] = [],
    lastApplied = 0,
    matched = position === 0;
  let attempts = 0,
    tokens = 0,
    edaCalls = 0,
    edaExecutions = 0;
  if (position === 0) same(snapshot, current, "Candidate snapshot");
  for (const e of events) {
    const seq = integer(e.sequence, "sequence");
    let changed = false;
    if (e.type === "model_request") attempts++;
    if (e.type === "model_response" || e.type === "model_failure") {
      const usage = obj(e.usage);
      tokens +=
        integer(usage.input_tokens ?? 0, "input tokens", 0) +
        integer(usage.output_tokens ?? 0, "output tokens", 0);
    }
    if (e.type === "action_accepted") {
      if (e.protocol_version !== (modern ? 3 : 2))
        throw new Error("Unsupported modeling action protocol");
      str(e.attempt_id, "accepted attempt");
      str(e.tool_id, "accepted tool");
      const raw = obj(payloads.get(seq)),
        { kind, ...parameters } = raw;
      const name =
        kind === "train"
          ? "run_experiment"
          : kind === "analyze"
            ? "analyze"
            : kind === "finish"
              ? "finish_modeling"
              : "invalid";
      const selected = (modern ? newAction : action)(
        name,
        JSON.stringify(parameters),
        integer(limits.max_code_bytes, "max code"),
        max,
        method ?? "adaptive_eda",
      );
      const selectedSources =
        selected.kind === "finish"
          ? []
          : "source_experiments" in selected
            ? selected.source_experiments
            : selected.source_experiment === null
              ? []
              : [selected.source_experiment];
      for (const source of selectedSources) {
        const origin = results.get(source);
        if (
          !origin ||
          origin.final ||
          (selected.kind === "analyze" && origin.status !== "completed")
        )
          throw new Error("Invalid accepted source experiment");
      }
      for (const update of selected.candidate_updates)
        evidence(
          update.evidence,
          analyses,
          confirmedAnalyses,
          obj(manifest.config).dataset,
        );
      const before = current;
      current = applyCandidateUpdates(
        current,
        selected.candidate_updates,
        max,
        method === "collaborative",
      );
      const intent = obj(e.intent);
      accepted.set(seq, { action: selected, intent });
      if (selected.kind === "analyze") {
        if (intent.kind !== "analysis")
          throw new Error("Analysis acceptance intent mismatch");
        for (const id of selected.candidates)
          requireCandidate(current, id, { active: true });
        const child = str(intent.child_id, "analysis child"),
          id = str(intent.analysis_id, "analysis ID");
        if (
          acceptedChildren.some(
            (x) => x.child_id === child || x.analysis_id === id,
          )
        )
          throw new Error("Duplicate analysis identity");
        const allocation = (
          manifest.schema_version === 3
            ? validateHostAllocation
            : validateAllocation
        )(intent.allocation);
        if ("requested" in allocation && "requested_budget" in selected)
          same(
            allocation.requested,
            selected.requested_budget,
            "Requested budget",
          );
        same(
          allocation.limits,
          {
            model_attempts: budget.eda_model_attempts,
            total_tokens: budget.eda_tokens,
            executions: budget.eda_executions,
            task_timeout_ms: budget.eda_timeout_ms,
            final_reserve_ms: budget.final_reserve_ms,
          },
          "Allocation limits",
        );
        same(
          allocation.remaining.model_attempts,
          integer(budget.model_attempts, "model attempts") - attempts,
          "Remaining model attempts",
        );
        same(
          allocation.remaining.total_tokens,
          integer(budget.total_tokens, "token budget") - tokens,
          "Remaining tokens",
        );
        same(
          allocation.remaining.executions,
          integer(budget.eda_executions, "execution budget", 0) - edaExecutions,
          "Remaining EDA executions",
        );
        same(
          allocation.remaining.eda_calls,
          integer(budget.eda_calls, "EDA calls", 0) - edaCalls,
          "Remaining EDA calls",
        );
        if (
          allocation.remaining.parent_task_ms >
          integer(budget.task_timeout_ms, "task timeout")
        )
          throw new Error("Remaining parent time exceeds task budget");
        edaCalls++;
        const start = Date.parse(str(intent.started_at, "allocation start")),
          deadline = Date.parse(str(intent.deadline_at, "allocation deadline"));
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(deadline) ||
          deadline - start !== allocation.effective.task_timeout_ms
        )
          throw new Error("Allocation deadline mismatch");
        acceptedChildren.push({ ...intent, sequence: seq });
      } else {
        if (
          intent.kind !== "experiment" ||
          intent.final !== (selected.kind === "finish")
        )
          throw new Error("Experiment acceptance intent mismatch");
        const candidate = str(intent.candidate_id, "candidate ID");
        requireCandidate(current, candidate, {
          active: selected.kind === "train",
        });
        if (selected.kind === "train") {
          same(candidate, selected.candidate_id, "Experiment candidate");
          same(
            intent.repair_of_experiment,
            selected.repair_of_experiment,
            "Repair reference",
          );
          evidence(
            selected.evidence,
            analyses,
            confirmedAnalyses,
            obj(manifest.config).dataset,
          );
          validateRepair(
            [...results.values()],
            candidate,
            selected.repair_of_experiment,
          );
        } else {
          const best = bestResult();
          if (
            !best ||
            selected.experiment_id !== best.id ||
            candidate !== best.candidate_id ||
            intent.repair_of_experiment !== null
          )
            throw new Error("Invalid final experiment selection");
        }
        const id = str(intent.experiment_id, "experiment ID");
        if (intents.has(id)) throw new Error("Duplicate experiment identity");
        intents.set(id, intent);
        current = attachExperiment(current, candidate, id);
      }
      histories.push({
        sequence: seq,
        updates: selected.candidate_updates,
        before,
        after: current,
        intent,
      });
      changed = true;
    } else if (e.type === "experiment_intent") {
      const id = str(e.experiment_id, "experiment ID"),
        acceptedSequence = integer(e.accepted_sequence, "accepted sequence");
      const origin = accepted.get(acceptedSequence);
      if (!origin || origin.intent.kind !== "experiment")
        throw new Error("Experiment lacks accepted decision");
      if (e.retry === true) {
        const previous = [...intents.values()]
          .filter((i) => i.final === true)
          .at(-1);
        const previousResult = previous
          ? results.get(String(previous.experiment_id))
          : undefined;
        if (
          origin.action.kind !== "finish" ||
          e.final !== true ||
          e.candidate_id !== origin.intent.candidate_id ||
          e.repair_of_experiment !== null ||
          intents.has(id) ||
          !previousResult ||
          previousResult.status !== "failed" ||
          !previousResult.reason.startsWith("error:") ||
          [...intents.values()].filter((i) => i.final === true).length >=
            integer(budget.final_training_attempts, "final training attempts")
        )
          throw new Error("Invalid final retry");
        intents.set(id, e);
        current = attachExperiment(
          current,
          str(e.candidate_id, "candidate ID"),
          id,
        );
        histories.push({ sequence: seq, intent: e, after: current });
        changed = true;
      } else {
        if (e.retry !== false)
          throw new Error("Invalid experiment dispatch marker");
        for (const key of [
          "experiment_id",
          "candidate_id",
          "final",
          "repair_of_experiment",
        ])
          same(e[key], origin.intent[key], "Experiment dispatch");
      }
    } else if (e.type === "child_intent" && e.analysis_id !== undefined) {
      const intent = acceptedChildren.find(
        (i) => i.analysis_id === e.analysis_id && i.child_id === e.child_id,
      );
      if (!intent) throw new Error("Analysis dispatch lacks accepted intent");
      same(e.accepted_sequence, intent.sequence, "Analysis accepted sequence");
      same(e.allocation, intent.allocation, "Analysis dispatched allocation");
    } else if (e.type === "experiment_result") {
      const id = str(e.experiment_id, "experiment ID"),
        intent = intents.get(id);
      if (!intent || results.has(id))
        throw new Error("Unknown or duplicate experiment result");
      const status = str(e.status, "experiment status");
      if (
        typeof intent.final !== "boolean" ||
        (status !== "completed" && status !== "failed")
      )
        throw new Error("Invalid experiment result");
      let score: Score | null = null;
      if (protocol) {
        if (status === "completed" && !intent.final)
          score = validateScore(e.score, protocol);
        else if (e.score !== null)
          throw new Error("Unexpected validation score");
      } else if (
        e.rmse !== null &&
        (typeof e.rmse !== "number" || !Number.isFinite(e.rmse) || e.rmse < 0)
      )
        throw new Error("Invalid experiment result");
      results.set(id, {
        id,
        candidate_id: str(intent.candidate_id, "candidate ID"),
        final: intent.final,
        status,
        ...(protocol ? { score } : { rmse: e.rmse as number | null }),
        reason: str(e.reason, "experiment reason"),
      });
    } else if (e.type === "child_result" && e.analysis_id !== undefined) {
      const intent = acceptedChildren.find(
        (x) => x.child_id === e.child_id && x.analysis_id === e.analysis_id,
      );
      if (!intent || confirmedAnalyses.has(String(e.analysis_id)))
        throw new Error("Unknown or duplicate analysis result");
      confirmedAnalyses.add(str(e.analysis_id, "analysis ID"));
      const analysis = analyses.find((a) => a.id === e.analysis_id);
      if (analysis) {
        same(analysis.status, e.status, "Analysis result status");
        const cost = ledger(analysis.cost);
        attempts += cost.attempts;
        tokens += cost.total_tokens;
        edaExecutions += integer(analysis.executions, "analysis executions", 0);
      }
    }
    if (changed) {
      lastApplied = seq;
      if (seq === position) {
        same(snapshot, current, "Candidate snapshot");
        matched = true;
      }
    }
  }
  if (!matched || (manifest.status === "completed" && position !== lastApplied))
    throw new Error("Candidate snapshot does not match applied history");
  const seenExperiments = new Set<string>();
  for (const experiment of experiments) {
    const id = str(experiment.id, "experiment ID"),
      result = results.get(id),
      intent = intents.get(id);
    if (!result || !intent || seenExperiments.has(id))
      throw new Error("Experiment fact lacks journal result");
    seenExperiments.add(id);
    for (const [key, value] of Object.entries(result))
      same(experiment[key], value, "Experiment fact");
    if (experiment.repair_of_experiment !== undefined)
      same(
        experiment.repair_of_experiment,
        intent.repair_of_experiment,
        "Experiment repair fact",
      );
  }
  if (
    manifest.status === "completed" &&
    (experiments.length !== results.size ||
      analyses.length !== confirmedAnalyses.size)
  )
    throw new Error("Completed manifest omits confirmed results");
  if (protocol) {
    same(
      manifest.best_experiment_id,
      bestResult()?.id ?? null,
      "Best experiment",
    );
    for (const a of analyses) {
      same(a.protocol_sha256, protocol.protocol_sha256, "Analysis protocol");
      const origin =
        a.source_experiment === null
          ? null
          : experiments.find((e) => e.id === a.source_experiment);
      if (a.source_experiment !== null && !origin)
        throw new Error("Unknown analysis experiment");
      const hash = origin?.predict
        ? obj(obj(origin.predict).output).sha256
        : null;
      same(a.prediction_sha256, hash, "Analysis prediction");
    }
  }
  const budgetView = await inspectAllocations(
    directory,
    manifest,
    analyses,
    acceptedChildren,
    confirmedAnalyses,
    accepted,
  );
  return {
    view: {
      version: 1,
      candidates: current,
      snapshot_applied_sequence: position,
      journal_applied_sequence: lastApplied,
      history: histories,
      analyses: budgetView,
    },
    accepted_children: acceptedChildren,
    unconfirmed_experiments: [...intents]
      .filter(([id]) => !results.has(id))
      .map(([, intent]) => intent),
  };
}

async function inspectAllocations(
  directory: string,
  manifest: Record<string, unknown>,
  analyses: Record<string, unknown>[],
  intents: Record<string, unknown>[],
  confirmed: Set<string>,
  accepted: Map<
    number,
    { action: ModelingAction; intent: Record<string, unknown> }
  >,
) {
  const view: Record<string, unknown>[] = [],
    seen = new Set<string>();
  for (const a of analyses) {
    const id = str(a.id, "analysis ID"),
      intent = intents.find(
        (i) => i.analysis_id === id && i.child_id === a.run_id,
      );
    if (!intent || !confirmed.has(id) || seen.has(id))
      throw new Error("Analysis settlement lacks unique confirmed intent");
    seen.add(id);
    const decision = accepted.get(
      integer(intent.sequence, "analysis accepted sequence"),
    );
    if (!decision || decision.action.kind !== "analyze")
      throw new Error("Missing accepted analysis decision");
    same(a.request, decision.action, "Analysis request");
    const allocation = (
      manifest.schema_version === 3
        ? validateHostAllocation
        : validateAllocation
    )(intent.allocation);
    if (a.allocation !== undefined)
      same(a.allocation, allocation, "Analysis allocation");
    same(a.effective_budget, allocation.effective, "Analysis effective budget");
    const cost = ledger(a.cost),
      roles = roleLedgers(cost, a.role_usage),
      executions = integer(a.executions, "analysis executions", 0);
    if (
      executions > allocation.effective.executions ||
      cost.attempts > allocation.effective.model_attempts
    )
      throw new Error("EDA usage exceeds dispatch limits");
    if (a.dispatch === "not_started") {
      if (
        a.directory !== null ||
        cost.attempts !== 0 ||
        cost.total_tokens !== 0 ||
        cost.status !== "known" ||
        executions !== 0 ||
        a.status === "completed"
      )
        throw new Error("Unstarted analysis claims execution");
    } else if (a.dispatch === "started") {
      const childDirectory = str(a.directory, "analysis directory");
      if (
        resolve(childDirectory) !==
        resolve(directory, "eda", str(a.run_id, "child ID"))
      )
        throw new Error("Analysis child directory mismatch");
      const child = await readManifest(childDirectory);
      if (
        child.run_id !== a.run_id ||
        !child.agent ||
        child.agent === "not_applicable" ||
        !child.collaboration
      )
        throw new Error("Invalid EDA child manifest");
      same(child.status, a.status, "EDA child status");
      for (const [key, value] of Object.entries(allocation.effective))
        same(obj(child.agent.budget)[key], value, "EDA child budget");
      same(ledger(child.tokens), cost, "EDA child usage");
      same(
        roleLedgers(child.tokens, {
          planner: child.collaboration.roles.planner.tokens,
          executor: child.collaboration.roles.executor.tokens,
        }),
        roles,
        "EDA child roles",
      );
      same(child.agent.executions, executions, "EDA child executions");
    } else throw new Error("Missing analysis dispatch state");
    view.push({
      analysis_id: id,
      child_id: a.run_id,
      allocation,
      status: a.status,
      cost,
      role_usage: roles,
      executions,
    });
  }
  if (manifest.usage) {
    const usage = obj(manifest.usage),
      children = obj(usage.children),
      modeling = ledger(usage.modeling),
      total = ledger(usage.tokens);
    for (const [id, child] of Object.entries(children)) {
      const a = analyses.find((a) => a.run_id === id);
      if (!a) throw new Error("Unknown child settlement");
      same(ledger(child), ledger(a.cost), "Child settlement");
    }
    const executions = Object.keys(children).reduce((sum, id) => {
      const a = analyses.find((a) => a.run_id === id);
      return sum + integer(a?.executions, "settled executions", 0);
    }, 0);
    same(usage.eda_executions, executions, "Parent execution accounting");
    for (const a of view) {
      a.settlement =
        children[String(a.child_id)] === undefined
          ? "unconfirmed"
          : "confirmed";
      if (manifest.status === "completed" && a.settlement !== "confirmed")
        throw new Error("Completed parent omits child settlement");
    }
    for (const key of [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "attempts",
      "unknown_attempts",
      "elapsed_ms",
    ] as const) {
      const expected =
        modeling[key] +
        Object.values(children).reduce<number>(
          (sum, child) => sum + ledger(child)[key],
          0,
        );
      if (Math.abs(expected - total[key]) > (key === "elapsed_ms" ? 1e-6 : 0))
        throw new Error(`Parent accounting mismatch: ${key}`);
    }
    if (
      total.status === "known" &&
      (modeling.status === "unknown" ||
        Object.values(children).some((c) => ledger(c).status === "unknown"))
    )
      throw new Error("Parent accounting status mismatch");
  }
  for (const intent of intents)
    if (!seen.has(String(intent.analysis_id)))
      view.push({ ...intent, settlement: "unconfirmed" });
  return view;
}
