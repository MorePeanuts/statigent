import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateAnalysis } from "../agent/actions";
import { regular, verifyFiles } from "../evaluation/files";
import { integer, obj, str, strings } from "../models/validation";
import { emptyLedger } from "../records/agent-metadata";
import { readManifest, sha256 } from "../records/store";
import { ledger, roleLedgers, validateHostAllocation } from "./budget";
import { validateModelingTask } from "./config";
import { datasetProtocol, validateDataset } from "./data";
import type { AnalysisRecord } from "./eda";
import type { Experiment, StageResult } from "./experiments";
import { validateBasicProfile } from "./profile";
import { better, validateScore } from "./protocol";
import { ValidationAudit } from "./validation-records";
import {
  acceptAttachments,
  type CoreAction,
  DECISION_INTERFACE,
  type Notes,
  parseCore,
  parseDeliveryState,
  parseSearchEnd,
  validateCore,
} from "./workflow";

function same(a: unknown, b: unknown, label: string) {
  if (!isDeepStrictEqual(a, b)) throw new Error(`${label} mismatch`);
}
function list(v: unknown) {
  if (!Array.isArray(v)) throw new Error("Expected record list");
  return v.map(obj);
}
function stage(v: unknown): StageResult | null {
  if (v === null) return null;
  const x = obj(v),
    image = obj(x.image);
  const file = (v: unknown) => {
    const f = obj(v);
    return {
      path: str(f.path, "path"),
      sha256: str(f.sha256, "hash"),
      bytes: integer(f.bytes, "bytes", 0),
    };
  };
  if (
    x.execution_confirmed !== undefined &&
    typeof x.execution_confirmed !== "boolean"
  )
    throw new Error("Invalid stage execution confirmation");
  const elapsed = x.elapsed_ms;
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0)
    throw new Error("Invalid stage time");
  return {
    ...(x.execution_confirmed === undefined
      ? {}
      : { execution_confirmed: x.execution_confirmed === true }),
    run_id: str(x.run_id, "stage ID"),
    directory: str(x.directory, "stage directory"),
    status: str(x.status, "stage status"),
    reason: str(x.reason, "stage reason"),
    output: x.output === null ? null : file(x.output),
    ...(x.metadata === undefined ? {} : { metadata: file(x.metadata) }),
    image: {
      id: str(image.id, "image"),
      platform: str(image.platform, "platform"),
    },
    elapsed_ms: elapsed,
  };
}
export async function inspectWorkflow(
  directory: string,
  manifest: Record<string, unknown>,
  events: Record<string, unknown>[],
  payloads: Map<number, unknown>,
) {
  const config = obj(manifest.config),
    task = validateModelingTask(config.task),
    dataset = validateDataset(config.dataset),
    protocol = datasetProtocol(dataset);
  same(config.protocol, protocol, "Record task protocol");
  same(
    obj(config.prompt).decision_interface,
    DECISION_INTERFACE,
    "Decision interface",
  );
  const end = parseSearchEnd(manifest.search_end),
    delivery = parseDeliveryState(manifest.delivery);
  if (manifest.status !== "running" && !end)
    throw new Error("Missing terminal search end");
  if ((manifest.status === "completed") !== (delivery.status === "completed"))
    throw new Error("Delivery completion mismatch");
  const audit = await ValidationAudit.create(directory, manifest);
  const rawExperiments = list(manifest.experiments),
    rawAnalyses = list(manifest.analyses);
  const experiments: Experiment[] = [],
    analyses: AnalysisRecord[] = [],
    history: Notes[] = [];
  const intents = new Map<string, Record<string, unknown>>(),
    analysisIntents = new Map<string, Record<string, unknown>>();
  const accepted = new Map<
    number,
    { core: CoreAction; intent: Record<string, unknown> }
  >();
  const warnings: unknown[] = [],
    relationships: unknown[] = [],
    children: Record<string, unknown>[] = [];
  let profile: ReturnType<typeof validateBasicProfile> | null = null,
    profileSha = "",
    best: Experiment | undefined,
    frozenSequence: number | null = null;
  let initial = false;
  if (manifest.basic_profile !== null) {
    const saved = obj(manifest.basic_profile),
      f = obj(saved.artifact),
      path = str(f.path, "profile path");
    if (path !== "basic-profile/profile.json")
      throw new Error("Invalid profile path");
    await verifyFiles(directory, [
      {
        path,
        sha256: str(f.sha256, "profile hash"),
        bytes: integer(f.bytes, "profile bytes"),
      },
    ]);
    profile = validateBasicProfile(
      JSON.parse(await readFile(await regular(directory, path), "utf8")),
      dataset,
    );
    profileSha = str(f.sha256, "profile hash");
    same(saved.profile, profile, "Profile snapshot");
  }
  const profileEvents = events.filter(
    (e) => e.type === "basic_profile_completed",
  );
  if (profile) {
    if (
      profileEvents.length !== 1 ||
      events.some(
        (e) =>
          e.type === "model_request" &&
          Number(e.sequence) < Number(profileEvents[0]?.sequence),
      )
    )
      throw new Error("Invalid profile acceptance order");
    same(
      profileEvents[0]?.artifact,
      obj(manifest.basic_profile).artifact,
      "Accepted profile",
    );
  } else if (
    profileEvents.length ||
    events.some((e) => e.type === "model_request")
  )
    throw new Error("Missing profile before search");
  const seenExperiments = new Set<string>(),
    seenAnalyses = new Set<string>();
  for (const event of events) {
    const seq = integer(event.sequence, "sequence");
    if (
      audit.frozen &&
      (event.type === "model_request" || event.type === "action_accepted")
    )
      throw new Error("Model/search continued after freeze");
    if (event.type === "initial_analysis_scheduled") {
      if (
        task.method !== "initial_eda" ||
        initial ||
        experiments.length ||
        events.some(
          (e) => e.type === "model_request" && Number(e.sequence) < seq,
        )
      )
        throw new Error("Invalid initial analysis order");
      same(event.version, 2, "Initial analysis version");
      initial = true;
    }
    if (event.type === "action_accepted") {
      if (event.protocol_version !== 4 || !profile)
        throw new Error("Invalid action protocol/profile");
      const body = obj(payloads.get(seq)),
        raw = obj(body.raw);
      if (event.origin !== "model" && event.origin !== "host_initial")
        throw new Error("Unknown action origin");
      if (
        event.origin === "host_initial" &&
        (!initial || task.method !== "initial_eda" || analysisIntents.size)
      )
        throw new Error("Invalid host analysis");
      const core = parseCore(
        str(event.tool_name, "tool name"),
        raw,
        task.limits.max_code_bytes,
        event.origin === "host_initial" ? "adaptive_eda" : task.method,
      );
      validateCore(core, experiments);
      const action = acceptAttachments(
        core,
        raw,
        task.method,
        {
          run_id: str(manifest.run_id, "run"),
          profile,
          profile_sha256: profileSha,
          protocol,
          experiments,
          analyses,
        },
        history.at(-1) ?? null,
        seq,
      );
      same(body.accepted, action, "Accepted action/attachments");
      if (action.notes) history.push(action.notes);
      warnings.push(...action.warnings.map((w) => ({ sequence: seq, ...w })));
      const intent = obj(event.intent);
      accepted.set(seq, { core, intent });
      if (core.kind === "train") {
        const id = str(intent.experiment_id, "experiment ID");
        if (
          intents.has(id) ||
          intent.kind !== "experiment" ||
          intent.candidate_id !== id ||
          intent.final !== false
        )
          throw new Error("Invalid experiment acceptance");
        same(
          intent.source_experiment,
          core.source_experiment,
          "Parent experiment",
        );
        same(
          intent.repair_of_experiment,
          core.repair_of_experiment,
          "Repair experiment",
        );
        audit.search(id, core.code, id, intent.evaluation);
        intents.set(id, intent);
        relationships.push({
          experiment_id: id,
          source_experiment: core.source_experiment,
          repair_of_experiment: core.repair_of_experiment,
          change: core.change,
          reason: core.reason,
        });
      } else if (core.kind === "analyze") {
        const id = str(intent.analysis_id, "analysis ID");
        if (analysisIntents.has(id) || intent.kind !== "analysis")
          throw new Error("Invalid analysis acceptance");
        validateHostAllocation(intent.allocation);
        analysisIntents.set(id, { ...intent, sequence: seq });
      } else same(intent.kind, "finish", "Finish intent");
    } else if (event.type === "search_frozen") {
      const trigger = parseSearchEnd(event.search_end);
      if (
        !trigger ||
        (trigger.kind !== "agent_finished" && trigger.kind !== "protected")
      )
        throw new Error("Invalid freeze trigger");
      if (trigger.kind === "agent_finished") {
        const action = accepted.get(
          integer(event.accepted_sequence, "finish sequence"),
        );
        if (action?.core.kind !== "finish" || event.origin !== "model")
          throw new Error("Freeze lacks finish action");
        same(action.core.reason, trigger.reason, "Finish reason");
      } else {
        const protection = obj(event.protection),
          costs = ledger(protection.tokens),
          remaining = integer(
            protection.remaining_ms,
            "Remaining closing time",
            0,
          ),
          errors = integer(
            protection.consecutive_unproductive,
            "Unproductive count",
            0,
          ),
          requestBytes = integer(protection.request_bytes, "Request bytes", 0);
        same(
          costs,
          obj(manifest.usage).tokens,
          "Protected accounting snapshot",
        );
        const cause =
          trigger.reason === "accounting_incomplete"
            ? costs.status === "unknown"
            : trigger.reason === "model_attempts"
              ? costs.attempts >= task.budget.model_attempts
              : trigger.reason === "token_threshold"
                ? costs.total_tokens >= task.budget.total_tokens
                : trigger.reason === "token_preflight"
                  ? costs.total_tokens + requestBytes >=
                    task.budget.total_tokens
                  : trigger.reason === "request_size_limit"
                    ? requestBytes > task.budget.max_request_bytes
                    : trigger.reason === "action_corrections"
                      ? errors > task.budget.action_corrections
                      : trigger.reason === "exploration_reserve"
                        ? remaining <= task.budget.final_reserve_ms
                        : false;
        if (!cause || remaining <= 0)
          throw new Error("Unsubstantiated protection trigger");
        same(event.origin, "host_protection", "Protected origin");
        same(event.accepted_sequence, null, "Protected sequence");
        if (
          ![
            "accounting_incomplete",
            "model_attempts",
            "token_threshold",
            "token_preflight",
            "request_size_limit",
            "action_corrections",
            "exploration_reserve",
          ].includes(trigger.reason)
        )
          throw new Error("Invalid protection reason");
        if (
          experiments.some(
            (e) =>
              e.execution_confirmed === false ||
              /kernel_lost|protocol_error|cleanup|record_failure|incomplete execution|scoring_failure/.test(
                e.reason,
              ),
          ) ||
          analyses.some((a) => a.execution_confirmed !== true) ||
          [...analysisIntents.keys()].some((id) => !seenAnalyses.has(id)) ||
          [...intents.keys()].some((id) => !seenExperiments.has(id))
        )
          throw new Error("Protection with unconfirmed execution");
      }
      same(trigger, end, "Search end snapshot");
      audit.freeze(
        str(event.search_best_experiment_id, "search best"),
        event.shortlist,
      );
      frozenSequence = seq;
    } else if (event.type === "experiment_intent") {
      const id = str(event.experiment_id, "experiment ID");
      if (event.phase === "search") {
        const a = accepted.get(
          integer(event.accepted_sequence, "accepted sequence"),
        );
        if (!a || a.core.kind !== "train")
          throw new Error("Search lacks accepted action");
        for (const key of [
          "experiment_id",
          "candidate_id",
          "phase",
          "evaluation",
          "source_experiment",
          "repair_of_experiment",
        ])
          same(event[key], a.intent[key], "Experiment dispatch");
      } else {
        same(event.frozen_sequence, frozenSequence, "Closing origin");
        audit.closingIntent(event);
        if (intents.has(id)) throw new Error("Duplicate closing intent");
        intents.set(id, event);
      }
    } else if (event.type === "experiment_result") {
      const id = str(event.experiment_id, "experiment ID"),
        raw = rawExperiments.find((e) => e.id === id),
        intent = intents.get(id);
      if (!intent || seenExperiments.has(id))
        throw new Error("Unknown experiment result");
      seenExperiments.add(id);
      audit.result(event);
      if (!raw) {
        if (manifest.status === "completed")
          throw new Error("Missing completed experiment");
        continue;
      }
      const ev = [
        audit.plan.search,
        ...audit.plan.confirmation,
        audit.plan.final,
      ].find((v) => v.evaluation_id === obj(raw.evaluation).evaluation_id);
      if (!ev || (raw.status !== "completed" && raw.status !== "failed"))
        throw new Error("Invalid experiment facts");
      same(raw.evaluation, ev, "Evaluation snapshot");
      const e: Experiment = {
        id,
        candidate_id: str(raw.candidate_id, "pipeline identity"),
        code: str(raw.code, "code"),
        code_sha256: str(raw.code_sha256, "code hash"),
        status: raw.status,
        reason: str(raw.reason, "reason"),
        score:
          raw.score === null
            ? null
            : validateScore(raw.score, protocol, ev.evaluation_id),
        fit: stage(raw.fit),
        predict: stage(raw.predict),
        final: raw.final === true,
        phase: ev.phase,
        evaluation: ev,
        source_search_experiment_id:
          raw.source_search_experiment_id === null
            ? null
            : str(raw.source_search_experiment_id, "source search"),
      };
      if (raw.training_diagnostic !== undefined) {
        const d = obj(raw.training_diagnostic);
        if (
          d.partition !== "train" ||
          e.phase !== "search" ||
          e.status !== "completed" ||
          (d.status !== "available" && d.status !== "unavailable") ||
          typeof d.elapsed_ms !== "number" ||
          !Number.isFinite(d.elapsed_ms) ||
          d.elapsed_ms < 0
        )
          throw new Error("Invalid training diagnostic");
        same(d, event.training_diagnostic, "Diagnostic journal");
        const members = sha256(Buffer.from(JSON.stringify(ev.split.train)));
        same(d.members_sha256, members, "Diagnostic members");
        same(d.model_sha256, e.fit?.output?.sha256, "Diagnostic model");
        const prediction = stage(d.prediction);
        const score =
          d.score === null
            ? null
            : validateScore(
                d.score,
                protocol,
                sha256(
                  Buffer.from(
                    JSON.stringify({
                      partition: "train",
                      search_evaluation_id: ev.evaluation_id,
                      members_sha256: members,
                    }),
                  ),
                ),
              );
        if (
          d.status === "available" &&
          (!score || prediction?.status !== "completed" || !prediction.output)
        )
          throw new Error("Unavailable diagnostic artifact");
        if (d.status === "unavailable" && score)
          throw new Error("Unconfirmed diagnostic score");
        e.training_diagnostic = {
          partition: "train",
          status: d.status,
          members_sha256: members,
          model_sha256: str(d.model_sha256, "model hash"),
          prediction,
          score,
          reason: str(d.reason, "diagnostic reason"),
          elapsed_ms: d.elapsed_ms,
        };
      } else
        same(event.training_diagnostic, null, "Missing diagnostic snapshot");
      if (raw.execution_confirmed !== undefined) {
        if (typeof raw.execution_confirmed !== "boolean")
          throw new Error("Invalid execution confirmation");
        e.execution_confirmed = raw.execution_confirmed;
      }
      experiments.push(e);
      if (
        e.phase === "search" &&
        e.status === "completed" &&
        e.score &&
        better(e.score, best?.score ?? null)
      )
        best = e;
    } else if (event.type === "confirmation_result")
      audit.update(payloads.get(seq));
    else if (event.type === "child_intent") children.push(event);
    else if (event.type === "child_result" && event.analysis_id !== undefined) {
      const id = str(event.analysis_id, "analysis ID"),
        raw = rawAnalyses.find((a) => a.id === id),
        intent = analysisIntents.get(id);
      if (!intent || !raw || seenAnalyses.has(id))
        throw new Error("Unknown analysis result");
      seenAnalyses.add(id);
      same(raw.run_id, intent.child_id, "Analysis child");
      same(raw.status, event.status, "Analysis status");
      const decision = accepted.get(
        integer(intent.sequence, "analysis sequence"),
      );
      if (decision?.core.kind !== "analyze")
        throw new Error("Missing analysis core");
      same(raw.request, decision.core, "Analysis request");
      const allocation = validateHostAllocation(intent.allocation),
        cost = ledger(raw.cost),
        roles = roleLedgers(cost, raw.role_usage);
      same(raw.effective_budget, allocation.effective, "Analysis budget");
      const executions = integer(raw.executions, "executions", 0);
      if (
        executions > allocation.effective.executions ||
        cost.attempts > allocation.effective.model_attempts
      )
        throw new Error("Analysis exceeds limits");
      const a: AnalysisRecord = {
        id,
        run_id: str(raw.run_id, "child ID"),
        directory:
          raw.directory === null ? null : str(raw.directory, "directory"),
        source_experiment:
          raw.source_experiment === null
            ? null
            : str(raw.source_experiment, "source experiment"),
        dataset_hash: str(raw.dataset_hash, "data hash"),
        split_hash: str(raw.split_hash, "split hash"),
        protocol_sha256: str(raw.protocol_sha256, "protocol hash"),
        status: str(raw.status, "status"),
        reason: str(raw.reason, "reason"),
        analysis: null,
        cost,
        role_usage: roles,
        executions,
        request: decision.core,
        execution_confirmed: raw.execution_confirmed === true,
      };
      same(a.dataset_hash, dataset.files[0]?.sha256, "Analysis data");
      same(a.split_hash, dataset.split.sha256, "Analysis split");
      same(a.protocol_sha256, protocol.protocol_sha256, "Analysis protocol");
      if (raw.dispatch === "not_started") {
        same(raw.directory, null, "Unstarted directory");
        same(cost, emptyLedger(), "Unstarted cost");
        same(executions, 0, "Unstarted execution");
        if (a.status === "completed") throw new Error("Unstarted success");
        a.dispatch = "not_started";
      } else if (raw.dispatch === "started" && a.directory) {
        same(
          resolve(a.directory),
          resolve(directory, "eda", a.run_id),
          "Child directory",
        );
        const child = await readManifest(a.directory);
        if (
          !child.agent ||
          child.agent === "not_applicable" ||
          !child.collaboration
        )
          throw new Error("Missing child manifest");
        for (const key of [
          "model_attempts",
          "total_tokens",
          "executions",
          "task_timeout_ms",
        ] as const)
          same(
            child.agent.budget[key],
            allocation.effective[key],
            "Native child budget",
          );
        same(child.status, a.status, "Child status");
        same(ledger(child.tokens), cost, "Child costs");
        same(
          roleLedgers(child.tokens, {
            planner: child.collaboration.roles.planner.tokens,
            executor: child.collaboration.roles.executor.tokens,
          }),
          roles,
          "Child role costs",
        );
        same(child.agent.executions, executions, "Child executions");
        same(
          a.execution_confirmed,
          child.workspace_collection.status === "complete",
          "Child cleanup",
        );
        if (a.status === "completed") {
          const native = obj(
            JSON.parse(
              await readFile(
                await regular(
                  a.directory,
                  str(child.agent.final_result, "result path"),
                ),
                "utf8",
              ),
            ),
          );
          const { run_id, ...result } = native;
          same(run_id, a.run_id, "Result child");
          same(raw.analysis, result, "Native analysis");
          const refs = new Set(
            list(result.findings).flatMap((f) =>
              strings(f.evidence_refs, "evidence"),
            ),
          );
          a.analysis = validateAnalysis(result, refs);
        } else same(raw.analysis, null, "Failed analysis findings");
        a.dispatch = "started";
        const source = await readFile(
            await regular(directory, join(`${id}-input`, "source.json")),
          ),
          context = await readFile(
            await regular(directory, join(`${id}-input`, "context.json")),
          );
        same(sha256(source), raw.source_sha256, "Analysis source hash");
        same(sha256(context), raw.context_sha256, "Analysis context hash");
        a.source_sha256 = sha256(source);
        a.context_sha256 = sha256(context);
        same(
          JSON.parse(context.toString()),
          {
            version: 1,
            question: decision.core.question,
            ...(task.method === "collaborative"
              ? {
                  notes:
                    history
                      .filter((n) => n.sequence <= Number(intent.sequence))
                      .at(-1) ?? null,
                }
              : {}),
          },
          "Analysis notes context",
        );
        const input = obj(JSON.parse(source.toString()));
        same(input.protocol, protocol, "Analysis input protocol");
        same(input.data, dataset.files[0], "Analysis input data");
        a.source_experiments = list(input.sources).map((s) => ({
          experiment_id: str(s.experiment_id, "source experiment"),
          prediction_sha256: str(s.prediction_sha256, "prediction hash"),
        }));
        same(
          raw.source_experiments,
          a.source_experiments,
          "Analysis input sources",
        );
        for (const origin of a.source_experiments)
          same(
            origin.prediction_sha256,
            experiments.find((e) => e.id === origin.experiment_id)?.predict
              ?.output?.sha256,
            "Analysis prediction",
          );
      } else throw new Error("Invalid analysis dispatch");
      analyses.push(a);
    }
  }
  same(
    manifest.notes_control,
    task.method === "collaborative" ? { version: 1, history } : "disabled",
    "Notes snapshot",
  );
  same(manifest.best_experiment_id, best?.id ?? null, "Best experiment");
  same(
    manifest.search_best_experiment_id,
    best?.id ?? null,
    "Search best experiment",
  );
  if (
    (end?.kind === "agent_finished" || end?.kind === "protected") &&
    !audit.frozen
  )
    throw new Error("Missing search freeze");
  audit.finish();
  const usage = obj(manifest.usage),
    total = ledger(usage.tokens),
    modeling = ledger(usage.modeling),
    settled = obj(usage.children);
  const responses = events.filter(
      (e) => e.type === "model_response" || e.type === "model_failure",
    ),
    requests = new Set(
      events.filter((e) => e.type === "model_request").map((e) => e.attempt_id),
    );
  const responseIds = new Set(responses.map((e) => e.attempt_id));
  if (
    responseIds.size !== responses.length ||
    responses.some((e) => !requests.has(e.attempt_id))
  )
    throw new Error("Invalid model settlement identity");
  if (manifest.status !== "running") {
    same(modeling.attempts, responses.length, "Model attempts");
    same(
      modeling.unknown_attempts,
      responses.filter(
        (e) =>
          e.accounting === "unknown" ||
          (e.type === "model_response" && obj(e.usage).status === "unknown"),
      ).length,
      "Unknown model attempts",
    );
    for (const key of ["input_tokens", "output_tokens"] as const) {
      same(
        modeling[key],
        responses.reduce(
          (sum, e) =>
            sum +
            (e.usage === null ? 0 : integer(obj(e.usage)[key] ?? 0, key, 0)),
          0,
        ),
        "Model token settlement",
      );
    }
  }
  for (const [id, cost] of Object.entries(settled))
    same(
      ledger(cost),
      analyses.find((a) => a.run_id === id)?.cost,
      "Child settlement",
    );
  for (const a of analyses)
    same(settled[a.run_id], a.cost, "Missing child settlement");
  for (const key of [
    "attempts",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "unknown_attempts",
    "elapsed_ms",
  ] as const) {
    const expected =
      modeling[key] + analyses.reduce((n, a) => n + a.cost[key], 0);
    if (Math.abs(total[key] - expected) > (key === "elapsed_ms" ? 1e-6 : 0))
      throw new Error("Parent accounting mismatch");
  }
  same(
    total.status,
    modeling.status === "unknown" ||
      analyses.some((a) => a.cost.status === "unknown")
      ? "unknown"
      : "known",
    "Accounting completeness",
  );
  same(
    usage.eda_executions,
    analyses.reduce((n, a) => n + a.executions, 0),
    "EDA executions",
  );
  if (
    manifest.status === "completed" &&
    (seenExperiments.size !== rawExperiments.length ||
      seenAnalyses.size !== rawAnalyses.length ||
      !audit.frozen)
  )
    throw new Error("Incomplete completed history");
  for (const intent of analysisIntents.values())
    if (!children.some((c) => c.child_id === intent.child_id))
      children.push({ ...intent, accepted_only: true });
  const completed = new Set(
    events.filter((e) => e.type === "child_result").map((e) => e.child_id),
  );
  return {
    candidate_control: "disabled" as const,
    knowledge_control: "disabled" as const,
    workflow_control: {
      version: 4,
      notes: task.method === "collaborative" ? history : "disabled",
      relationships,
      warnings,
      search_end: end,
      delivery_status: delivery.status,
      accounting: total.status,
    },
    unconfirmed_children: children.filter((e) => !completed.has(e.child_id)),
    unconfirmed_experiments: [...intents]
      .filter(([id]) => !seenExperiments.has(id))
      .map(([, v]) => v),
  };
}
