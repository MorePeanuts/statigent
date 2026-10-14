import { randomUUID } from "node:crypto";
import { sha256 } from "../records/store";
import type {
  Experiment,
  StageResult,
  TrainingDiagnostic,
} from "./experiments";
import { ScoringFailure } from "./scoring";
import type { Evaluation } from "./validation";

// 数据版本只决定物化和计分。执行顺序、辅助诊断失败和未知执行状态共用一条路径。
export async function executeExperimentLifecycle<S>(o: {
  id?: string;
  candidateId: string;
  code: string;
  maxCodeBytes: number;
  final: boolean;
  fitOnly?: boolean;
  evaluation?: Evaluation;
  sourceSearchExperimentId?: string;
  members: string[];
  diagnostic: boolean;
  signal: AbortSignal;
  remaining: () => number;
  fit: () => Promise<StageResult>;
  predict: (
    fit: StageResult,
    partition: "validation" | "training" | "test",
  ) => Promise<StageResult>;
  validateAndScore: (
    prediction: StageResult,
    partition: "validation" | "training" | "test",
    evaluationId?: string,
  ) => Promise<S | null>;
}): Promise<Experiment<S>> {
  if (o.fitOnly && !o.final)
    throw new Error("Only final training can freeze a model");
  if (Buffer.byteLength(o.code) > o.maxCodeBytes)
    throw new Error("Code exceeds limit");
  const e: Experiment<S> = {
    id: o.id ?? randomUUID(),
    candidate_id: o.candidateId,
    code: o.code,
    code_sha256: sha256(Buffer.from(o.code)),
    status: "failed",
    reason: "not_started",
    score: null,
    fit: null,
    predict: null,
    final: o.final,
    ...(o.evaluation
      ? {
          phase: o.evaluation.phase,
          evaluation: o.evaluation,
          source_search_experiment_id: o.sourceSearchExperimentId ?? null,
        }
      : {}),
  };
  e.fit = await o.fit();
  e.execution_confirmed = e.fit.execution_confirmed;
  if (e.fit.status !== "completed") {
    e.reason = e.fit.reason;
    return e;
  }
  if (o.signal.aborted || o.remaining() <= 0) {
    e.reason = "cancelled_or_deadline";
    return e;
  }
  if (o.fitOnly) {
    e.status = "completed";
    e.reason = "model_frozen";
    return e;
  }
  const partition = o.final ? "test" : "validation";
  e.predict = await o.predict(e.fit, partition);
  e.execution_confirmed =
    e.execution_confirmed !== false && e.predict.execution_confirmed !== false;
  if (e.predict.status !== "completed") {
    e.reason = e.predict.reason;
    return e;
  }
  try {
    e.score = await o.validateAndScore(
      e.predict,
      partition,
      o.evaluation?.evaluation_id,
    );
    if ((o.final && e.score !== null) || (!o.final && e.score === null))
      throw new Error("Invalid experiment score presence");
    e.status = "completed";
    e.reason = "ok";
  } catch (error) {
    e.reason = error instanceof ScoringFailure ? error.message : String(error);
  }
  if (
    e.status !== "completed" ||
    !o.diagnostic ||
    o.evaluation?.phase !== "search"
  )
    return e;
  const began = performance.now();
  const diagnostic: TrainingDiagnostic<S> = {
    partition: "train",
    status: "unavailable",
    members_sha256: sha256(Buffer.from(JSON.stringify(o.members))),
    model_sha256: e.fit.output?.sha256 ?? "",
    prediction: null,
    score: null,
    reason: "not_started",
    elapsed_ms: 0,
  };
  e.training_diagnostic = diagnostic;
  if (o.remaining() <= 0 && !o.signal.aborted) {
    diagnostic.reason = "exploration_reserve";
    return e;
  }
  try {
    diagnostic.prediction = await o.predict(e.fit, "training");
    if (diagnostic.prediction.status !== "completed")
      throw new Error(diagnostic.prediction.reason);
    const identity = sha256(
      Buffer.from(
        JSON.stringify({
          partition: "train",
          search_evaluation_id: o.evaluation.evaluation_id,
          members_sha256: diagnostic.members_sha256,
        }),
      ),
    );
    diagnostic.score = await o.validateAndScore(
      diagnostic.prediction,
      "training",
      identity,
    );
    if (diagnostic.score === null) throw new Error("Invalid diagnostic score");
    diagnostic.status = "available";
    diagnostic.reason = "ok";
  } catch (error) {
    diagnostic.reason = String(error);
    // 正常的辅助预测失败不抹掉验证结果；未知执行或损坏记录必须阻止继续搜索。
    if (
      !diagnostic.prediction ||
      diagnostic.prediction.execution_confirmed === false ||
      /kernel_lost|protocol_error|cleanup|record|incomplete|integrity|hash|scoring_failure/.test(
        diagnostic.reason,
      )
    ) {
      e.execution_confirmed = false;
      e.reason = `diagnostic_integrity_failure:${diagnostic.reason}`;
    }
  } finally {
    diagnostic.elapsed_ms = performance.now() - began;
  }
  return e;
}
