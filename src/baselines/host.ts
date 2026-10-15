import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Stop } from "../agent/stop";
import { inspectImage } from "../evaluation/agents/docker";
import { nativeModelingPublication } from "../evaluation/benchmarks/modeling/publication";
import {
  emptyUsage,
  type Invocation,
  type Submission,
  type TerminalStatus,
} from "../evaluation/contracts";
import { describeFile, verifyFiles } from "../evaluation/files";
import { command } from "../evaluation/process";
import { DEFAULT_LIMITS } from "../execution/protocol";
import { ChatClient, type ModelClient } from "../models/client";
import { sha256 } from "../records/store";
import { freezeContainerBundle } from "./bundle";
import {
  baselineOptionsSchema,
  methodConfigIdentity,
  methodManifest,
} from "./catalog";
import { baselineExecution } from "./execution";
import { baselineModel } from "./model";
import { PredictionCleanupError, predictBundle } from "./predict";
import {
  type BaselineSubmission,
  type BridgeRequest,
  relativePathSchema,
} from "./protocol";
import { REACT_PROMPT, runReAct } from "./react";
import { BaselineRecorder } from "./records";
import { baselineTrajectory, deliverBaselineReport } from "./report";
import { publicWorkerView, runTrustedWorker } from "./worker";

export async function runBaseline(
  i: Invocation,
  signal: AbortSignal | undefined,
  dependencies: { client?: ModelClient; image?: typeof inspectImage } = {},
): Promise<Submission> {
  const settings = baselineOptionsSchema.parse(i.config.options);
  const automl = settings.method === "autogluon";
  const profile = i.config.model;
  if (
    !automl &&
    (!profile ||
      i.budget.model_attempts === null ||
      i.budget.total_tokens === null)
  )
    throw new Error("Model and finite budgets required");
  const started = performance.now(),
    runId = randomUUID(),
    directory = join(i.run_root, runId);
  await mkdir(i.run_root, { recursive: true });
  const timed = new AbortController(),
    combined = signal ? AbortSignal.any([signal, timed.signal]) : timed.signal;
  const timer = setTimeout(
    () => timed.abort(new Error("baseline_task_deadline")),
    i.budget.timeout_ms,
  );
  const remaining = () =>
    Math.max(0, i.budget.timeout_ms - (performance.now() - started));
  const reserve =
    i.task.output.kind === "predictions" ? settings.delivery_reserve_ms : 0;
  if (reserve >= i.budget.timeout_ms) {
    clearTimeout(timer);
    throw new Error("Delivery reserve must leave search time");
  }
  const result: Submission = {
    schema_version: 3,
    unit_id: i.unit_id,
    status: "failed",
    reason: "baseline_not_completed",
    answer_text: "",
    deliverables: [],
    trajectory: null,
    native_run: null,
    usage: {
      ...emptyUsage("not_applicable"),
      source: automl ? "not_applicable" : "measured",
    },
    cleanup_error: null,
    record_error: false,
  };
  let recorder: BaselineRecorder | undefined,
    execution: Awaited<ReturnType<typeof baselineExecution>> | undefined,
    model: ReturnType<typeof baselineModel> | undefined;
  let phase: "search" | "freezing" | "predicting" | "terminal" = "search";
  let registered: { bundle: string; entrypoint: string } | null = null,
    report: string | null = null;
  const steps: {
    code: string;
    status: string;
    preview: string;
    epoch: number;
  }[] = [];
  let searchEnd: { status: TerminalStatus; reason: string } = {
    status: "completed",
    reason: "explicit_submission",
  };
  let recoveredDelivery = false;
  let fatalExecution: Stop | null = null;
  try {
    const image = await (dependencies.image ?? inspectImage)(settings.image);
    const [commit, dirty] = await Promise.all([
      command(["git", "rev-parse", "HEAD"]),
      command(["git", "status", "--porcelain"]),
    ]);
    recorder = await BaselineRecorder.create(directory, {
      run_id: runId,
      unit_id: i.unit_id,
      method: methodManifest(settings.method),
      config_hash: methodConfigIdentity(settings),
      environment: {
        image,
        seed: i.seed,
        config: settings,
        budget: i.budget,
        model: profile,
        code: { commit: commit.stdout.trim(), dirty: dirty.stdout.length > 0 },
        react_prompt: settings.method === "react" ? REACT_PROMPT : null,
      },
    });
    const log = (type: string, details: Record<string, unknown>) => {
      if (!recorder) throw new Error("Recorder unavailable");
      return recorder.event(type, details);
    };
    const publication =
      i.task.output.kind === "predictions"
        ? await nativeModelingPublication(i)
        : null;
    const root = publication ? i.phase_roots?.search : i.input_root;
    if (!root) throw new Error("Missing search root");
    const files = i.task.inputs.filter(
      (f) =>
        !i.task.phase_inputs || i.task.phase_inputs.search.includes(f.path),
    );
    await verifyFiles(root, files);
    if (
      !automl &&
      profile &&
      i.budget.model_attempts !== null &&
      i.budget.total_tokens !== null
    )
      model = baselineModel({
        client: dependencies.client ?? new ChatClient(profile),
        signal: combined,
        budget: {
          model_attempts: i.budget.model_attempts,
          total_tokens: i.budget.total_tokens,
          timeout_ms: i.budget.timeout_ms,
        },
        remainingTime: () => remaining() - reserve,
        event: log,
      });
    execution = await baselineExecution({
      config: {
        run_id: runId,
        image: String(image.image_id),
        platform: String(image.platform),
        backend:
          settings.backend === "automl" ? "fresh-script" : settings.backend,
        input_root: root,
        inputs: files.map((f) => f.path),
        staging_root: join(directory, "staging"),
        seed: i.seed,
        limits: {
          ...DEFAULT_LIMITS,
          cpus: settings.limits.cpus,
          memory_bytes: settings.limits.memory_bytes,
          workspace_bytes: settings.limits.workspace_bytes,
          tmp_bytes: settings.limits.max_bundle_bytes + 256 * 1024 ** 2,
          cell_timeout_ms: Math.min(
            automl
              ? Math.max(1, Math.floor(remaining() - reserve))
              : settings.limits.cell_timeout_ms,
            Math.floor(remaining()),
          ),
          task_timeout_ms: Math.max(1, Math.floor(remaining())),
        },
      },
      artifactDirectory: join(directory, "artifacts"),
      event: log,
      allowKnownReplay: settings.method === "datawiseagent",
    });
    const runtime = execution,
      llm = model;
    const finish = async (submission: BaselineSubmission) => {
      if (phase !== "search" || combined.aborted)
        throw new Error("Delivery phase closed/cancelled");
      if (submission.kind !== i.task.output.kind)
        throw new Error("Output kind mismatch");
      llm?.close();
      if (submission.kind === "text") result.answer_text = submission.answer;
      else if (submission.kind === "report" && i.task.output.kind === "report")
        report = await deliverBaselineReport(
          runtime.artifacts,
          submission.path,
          i.task.output,
          i.deliverables_root,
        );
      else if (
        submission.kind === "predictions" &&
        i.task.output.kind === "predictions" &&
        publication
      ) {
        registered = {
          bundle: submission.bundle,
          entrypoint: submission.entrypoint,
        };
        phase = "freezing";
        runtime.seal();
        await log("phase_changed", {
          phase,
          registered,
          search_end: searchEnd,
        });
        const frozen = await freezeContainerBundle({
          container: runtime.session.containerName,
          bundle: registered.bundle,
          entrypoint: registered.entrypoint,
          destination: join(directory, "bundle"),
          image: String(image.image_id),
          platform: String(image.platform),
          maxFiles: settings.limits.max_bundle_files,
          maxBytes: settings.limits.max_bundle_bytes,
          signal: combined,
          timeout_ms: remaining(),
          stop: () => runtime.closeAfterSnapshot(),
        });
        phase = "predicting";
        await log("phase_changed", {
          phase,
          bundle_id: frozen.manifest.bundle_id,
        });
        const predictionRoot = join(directory, "prediction-input");
        await mkdir(predictionRoot);
        await publication.publishPrediction(predictionRoot);
        const features = publication.dataset.prediction;
        if (!features) throw new Error("Missing prediction feature identity");
        const predicted = await predictBundle({
          bundleRoot: frozen.root,
          bundle: frozen.manifest,
          featuresRoot: predictionRoot,
          features,
          protocol: i.task.output.protocol,
          limits: i.task.output.limits,
          seed: i.seed,
          directory: join(directory, "prediction"),
          timeout_ms: remaining(),
          cpus: settings.limits.cpus,
          memory_bytes: settings.limits.memory_bytes,
          signal: combined,
        });
        for (const path of [
          i.task.output.prediction_file,
          i.task.output.manifest_file,
        ])
          await mkdir(dirname(join(i.deliverables_root, path)), {
            recursive: true,
          });
        await copyFile(
          predicted.path,
          join(i.deliverables_root, i.task.output.prediction_file),
        );
        const descriptor = await describeFile(
          i.deliverables_root,
          i.task.output.prediction_file,
        );
        const producer = {
          adapter: settings.method,
          method: settings.method,
          version: methodManifest(settings.method).version,
          config_hash: methodConfigIdentity(settings),
          run_id: runId,
        };
        const bundleRef = {
          bundle_id: frozen.manifest.bundle_id,
          manifest_sha256: sha256(
            await readFile(join(directory, "bundle/bundle.json")),
          ),
          bytes: frozen.manifest.bytes,
          file_count: frozen.manifest.files.length,
          entrypoint: frozen.manifest.entrypoint,
          image: frozen.manifest.image,
          platform: frozen.manifest.platform,
          frozen_at: frozen.manifest.frozen_at,
        };
        await writeFile(
          join(i.deliverables_root, i.task.output.manifest_file),
          JSON.stringify({
            schema_version: 2,
            kind: "modeling-predictions",
            task_id: i.task.id,
            task_version: i.task.version,
            protocol: i.task.output.protocol,
            seed: i.seed,
            dataset_sha256: publication.dataset.dataset_sha256,
            expected_features: features,
            predictions: descriptor,
            export: null,
            producer,
            model_bundle: bundleRef,
            execution_preparation: null,
            workflow: {
              search_end: searchEnd,
              delivery_status: "completed",
              prediction_status: "completed",
              reproduction_status: "not_run",
              confirmation: "not_applicable",
              usage: llm?.usage() ?? result.usage,
              wall_ms: performance.now() - started,
            },
          }),
          { flag: "wx" },
        );
        await writeFile(
          join(directory, "reproduction-input.json"),
          JSON.stringify({
            schema_version: 1,
            producer,
            task: i.task,
            seed: i.seed,
            bundle_directory: "bundle",
            model_bundle: bundleRef,
            features_directory: "prediction-input",
            features,
            predictions: {
              path: "prediction/predictions.csv",
              bytes: predicted.bytes,
              sha256: predicted.sha256,
            },
            resources: {
              cpus: settings.limits.cpus,
              memory_bytes: settings.limits.memory_bytes,
            },
          }),
          { flag: "wx" },
        );
      }
      phase = "terminal";
      result.status = "completed";
      result.reason =
        searchEnd.status === "completed"
          ? "explicit_submission"
          : `delivered_after_${searchEnd.status}`;
      await log("submitted", { submission, search_end: searchEnd });
      return { accepted: true };
    };
    const recover = async (error: unknown) => {
      if (
        error instanceof Stop &&
        ["budget_exhausted", "timed_out"].includes(error.status) &&
        registered &&
        phase === "search" &&
        !combined.aborted &&
        remaining() > 0
      ) {
        searchEnd = { status: error.status, reason: error.reason };
        await finish({ kind: "predictions", ...registered });
        recoveredDelivery = true;
        return true;
      }
      return false;
    };
    const handle = async (
      request: BridgeRequest,
      requestSignal: AbortSignal = combined,
    ): Promise<Record<string, unknown>> => {
      if (phase !== "search")
        throw new Error("Baseline search is frozen/closed");
      requestSignal.throwIfAborted();
      combined.throwIfAborted();
      if (request.type === "submission.finish")
        return finish(request.submission);
      if (request.type === "model.request") {
        try {
          if (!llm) throw new Error("AutoML has no model channel");
          return { ...(await llm.request(request.messages, request.stage)) };
        } catch (error) {
          await recover(error);
          throw error;
        }
      }
      if (request.type === "bundle.register") {
        if (i.task.output.kind !== "predictions")
          throw new Error("Bundle registration requires modeling");
        registered = {
          bundle: relativePathSchema.parse(request.bundle),
          entrypoint: relativePathSchema.parse(request.entrypoint),
        };
        await log("bundle_registered", registered);
        return { registered: true };
      }
      if (remaining() <= reserve) {
        const error = new Stop("timed_out", "search_deadline");
        await recover(error);
        throw error;
      }
      if (request.type === "execution.execute") {
        const output = await runtime.execute(
          request.code,
          request.request_id,
          requestSignal,
        );
        steps.push({
          code: request.code,
          status: output.status,
          preview: output.preview,
          epoch: runtime.usage().kernel_epoch,
        });
        if (!runtime.stateKnown) {
          fatalExecution = new Stop(
            output.status === "timed_out"
              ? "timed_out"
              : output.status === "cancelled"
                ? "cancelled"
                : "failed",
            `execution_unavailable:${output.status}`,
          );
          phase = "terminal";
          llm?.close();
          throw fatalExecution;
        }
        return { ...output };
      }
      if (request.type === "execution.restart")
        return runtime.restart(request.reason, requestSignal);
      if (request.type === "artifact.read")
        return runtime.artifacts.response(request.path);
      if (request.type === "workspace.status")
        return {
          inputs: files.map((f) => f.path),
          artifacts: runtime.artifacts.list(),
        };
      if (request.type === "notebook.record") {
        await log("notebook", { notebook: request.notebook });
        return { accepted: true };
      }
      throw new Error("Unknown bridge request");
    };
    try {
      if (automl) {
        if (!publication) throw new Error("AutoML requires prediction task");
        const manifest = files.find((f) => f.path.endsWith("dataset.json"));
        if (!manifest) throw new Error("Public dataset manifest missing");
        const code = `from statigent_baselines.autogluon_model import train\nprint(train(${JSON.stringify(`/input/${manifest.path}`)}, "/tmp/baseline-models/selected", ${Math.max(1, (remaining() - reserve) / 1000)}, ${Math.max(1, Math.floor(settings.limits.cpus))}, ${i.seed}))`;
        const output = await runtime.execute(code, "automl-train", combined);
        steps.push({
          code,
          status: output.status,
          preview: output.preview,
          epoch: runtime.usage().kernel_epoch,
        });
        await log("automl_training", { output });
        if (output.status !== "ok")
          throw new Error(
            `AutoML training failed (${output.status}): ${JSON.stringify(output.error)} ${output.preview}`,
          );
        await finish({
          kind: "predictions",
          bundle: "selected",
          entrypoint: "predict.py",
        });
      } else if (settings.method === "react" && llm)
        await runReAct({
          runId,
          task: {
            goal: i.task.goal,
            constraints: i.task.constraints,
            files: files.map((f) => f.path),
            output: i.task.output,
            seed: i.seed,
          },
          maxTurns: settings.max_turns,
          model: llm,
          handle,
        });
      else
        await runTrustedWorker({
          view: publicWorkerView(i, runId),
          directory: join(directory, "worker"),
          timeout_ms: Math.max(1, Math.floor(remaining())),
          signal: combined,
          recorder,
          handle,
          stopExecution: () => runtime.close(),
        });
    } catch (error) {
      if (fatalExecution) throw fatalExecution;
      if (!recoveredDelivery && !(await recover(error))) throw error;
    }
    if (result.status !== "completed")
      throw new Error("No explicit baseline delivery");
  } catch (error) {
    if (error instanceof PredictionCleanupError)
      result.cleanup_error = String(error);
    result.status = combined.aborted
      ? signal?.aborted
        ? "cancelled"
        : "timed_out"
      : error instanceof Stop
        ? error.status
        : "failed";
    result.reason = String(error);
    if (!recorder) {
      try {
        recorder = await BaselineRecorder.create(directory, {
          run_id: runId,
          unit_id: i.unit_id,
          method: methodManifest(settings.method),
          config_hash: methodConfigIdentity(settings),
          environment: {
            config: settings,
            model: profile,
            seed: i.seed,
            budget: i.budget,
            startup_error: String(error),
          },
        });
      } catch {
        result.record_error = true;
      }
    }
  } finally {
    clearTimeout(timer);
    model?.close();
    try {
      await execution?.close();
    } catch (error) {
      result.cleanup_error = String(error);
      result.status = "failed";
      result.reason = "cleanup_unconfirmed";
    }
    result.usage = model?.usage() ?? result.usage;
    if (i.trajectory) {
      try {
        await mkdir(i.deliverables_root, { recursive: true });
        await writeFile(
          join(i.deliverables_root, "trajectory.txt"),
          baselineTrajectory(steps, report),
          { flag: "wx" },
        );
        result.trajectory = "trajectory.txt";
      } catch (error) {
        result.record_error = true;
        result.status = "failed";
        result.reason = `trajectory_record_failure:${error}`;
      }
    }
    if (recorder) {
      try {
        const record = await recorder.finish({
          status: result.status,
          reason: result.reason,
          usage: result.usage,
          cleanup_error: result.cleanup_error,
        });
        result.record_error ||= record.record_error;
      } catch (error) {
        result.record_error = true;
        result.status = "failed";
        result.reason = `record_failure:${error}`;
      }
    }
    if (result.record_error) result.status = "failed";
  }
  return result;
}
