import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { regular, verifyFiles } from "../evaluation/files";
import { obj, str } from "../models/validation";
import { sha256 } from "../records/store";
import { validateModelingTask } from "./config";
import {
  type ConfirmationResult,
  confirmationResult,
  shortlist,
} from "./confirmation";
import { datasetProtocol, tableFile, validateDataset } from "./data";
import type { Experiment } from "./experiments";
import { validateScore } from "./protocol";
import {
  createValidationPlan,
  type Evaluation,
  type ValidationPlan,
} from "./validation";

function same(a: unknown, b: unknown, label: string) {
  if (!isDeepStrictEqual(a, b)) throw new Error(`${label} mismatch`);
}
export class ValidationAudit {
  frozen = false;
  private candidates: Experiment[] = [];
  private confirmation: ConfirmationResult | null = null;
  private readonly results = new Map<string, Experiment>();
  private readonly intentions = new Map<
    string,
    {
      code: string;
      candidate: string;
      evaluation: Evaluation;
      source: string | null;
    }
  >();
  private readonly raw = new Map<string, Record<string, unknown>>();
  private constructor(
    readonly manifest: Record<string, unknown>,
    readonly plan: ValidationPlan,
  ) {
    if (!Array.isArray(manifest.experiments))
      throw new Error("Missing experiments");
    for (const raw of manifest.experiments) {
      const e = obj(raw),
        id = str(e.id, "experiment ID");
      if (this.raw.has(id)) throw new Error("Duplicate experiment");
      this.raw.set(id, e);
    }
  }
  static async create(directory: string, manifest: Record<string, unknown>) {
    const config = obj(manifest.config),
      task = validateModelingTask(config.task),
      dataset = validateDataset(config.dataset);
    const trainFile = dataset.files[0];
    if (!trainFile) throw new Error("Missing training identity");
    await verifyFiles(task.dataset_root, [trainFile]);
    const plan = createValidationPlan(
      dataset,
      await tableFile(task.dataset_root, "train.csv"),
      task.confirmation.mode,
    );
    same(config.validation_plan, plan, "Validation plan");
    const bytes = await readFile(
      await regular(directory, "validation-plan.json"),
    );
    same(sha256(bytes), config.validation_plan_sha256, "Validation plan hash");
    same(JSON.parse(bytes.toString()), plan, "Frozen validation plan");
    return new ValidationAudit(manifest, plan);
  }
  get protocol() {
    return datasetProtocol(validateDataset(obj(this.manifest.config).dataset));
  }
  search(id: string, code: string, candidate: string, evaluation: unknown) {
    if (this.frozen) throw new Error("Search continued after finish");
    same(evaluation, this.plan.search, "Search evaluation");
    if (this.intentions.has(id)) throw new Error("Duplicate experiment intent");
    this.intentions.set(id, {
      code,
      candidate,
      evaluation: this.plan.search,
      source: null,
    });
  }
  freeze(best: string, claimed: unknown) {
    if (this.frozen) throw new Error("Repeated finish");
    this.candidates = shortlist(
      [...this.results.values()],
      this.protocol,
      this.plan,
    );
    same(this.candidates[0]?.id, best, "Search best at finish");
    same(
      claimed,
      this.candidates.map((e) => ({
        experiment_id: e.id,
        code_sha256: e.code_sha256,
      })),
      "Frozen shortlist",
    );
    this.frozen = true;
  }
  closingIntent(event: Record<string, unknown>) {
    if (!this.frozen) throw new Error("Closing before finish");
    const id = str(event.experiment_id, "experiment ID"),
      source = str(
        event.source_search_experiment_id,
        "source search experiment",
      ),
      candidate = this.candidates.find((e) => e.id === source);
    if (!candidate || this.intentions.has(id))
      throw new Error("Invalid closing identity");
    const rawEvaluation = obj(event.evaluation),
      evaluation =
        event.final === true
          ? this.plan.final
          : this.plan.confirmation.find(
              (e) => e.evaluation_id === rawEvaluation.evaluation_id,
            );
    if (!evaluation || event.phase !== evaluation.phase)
      throw new Error("Invalid closing phase");
    same(rawEvaluation, evaluation, "Closing evaluation");
    same(event.candidate_id, candidate.candidate_id, "Closing candidate");
    same(event.repair_of_experiment, null, "Closing repair");
    if (event.final === true) {
      if (
        !this.confirmation ||
        !["disabled", "complete"].includes(this.confirmation.status) ||
        this.confirmation.selected_experiment_id !== source
      )
        throw new Error("Final fit lacks confirmed selection");
      const previous = [...this.results.values()].filter((e) => e.final).at(-1);
      if (
        event.retry === true
          ? !previous ||
            previous.status !== "failed" ||
            !previous.reason.startsWith("error:")
          : Boolean(previous)
      )
        throw new Error("Invalid closing retry");
      if (
        [...this.intentions.values()].filter(
          (e) => e.evaluation.phase === "final",
        ).length >=
        validateModelingTask(obj(this.manifest.config).task).budget
          .final_training_attempts
      )
        throw new Error("Final attempt limit");
    } else if (
      event.retry !== false ||
      [...this.intentions.values()].some(
        (e) =>
          e.source === source &&
          e.evaluation.evaluation_id === evaluation.evaluation_id,
      )
    )
      throw new Error("Duplicate confirmation trial");
    this.intentions.set(id, {
      code: candidate.code,
      candidate: candidate.candidate_id,
      evaluation,
      source,
    });
  }
  result(event: Record<string, unknown>) {
    const id = str(event.experiment_id, "experiment ID"),
      intent = this.intentions.get(id);
    if (!intent || this.results.has(id))
      throw new Error("Unknown or duplicate evaluated result");
    same(event.evaluation, intent.evaluation, "Result evaluation");
    same(event.phase, intent.evaluation.phase, "Result phase");
    const raw = this.raw.get(id);
    if (!raw) return; // Interrupted snapshots are reported as incomplete by the parent inspector.
    for (const key of ["status", "score", "reason", "phase", "evaluation"])
      same(raw[key], event[key], `Experiment ${key}`);
    same(raw.code, intent.code, "Frozen experiment code");
    same(raw.code_sha256, sha256(Buffer.from(intent.code)), "Pipeline hash");
    same(raw.candidate_id, intent.candidate, "Experiment candidate");
    same(raw.source_search_experiment_id, intent.source, "Experiment source");
    same(raw.final, intent.evaluation.phase === "final", "Final phase");
    if (raw.status !== "completed" && raw.status !== "failed")
      throw new Error("Invalid experiment status");
    const score =
      raw.status === "completed" && raw.final !== true
        ? validateScore(
            raw.score,
            this.protocol,
            intent.evaluation.evaluation_id,
          )
        : null;
    if (score === null && raw.score !== null)
      throw new Error("Unexpected phase score");
    this.results.set(id, {
      id,
      candidate_id: intent.candidate,
      code: intent.code,
      code_sha256: sha256(Buffer.from(intent.code)),
      status: raw.status,
      reason: str(raw.reason, "reason"),
      score,
      phase: intent.evaluation.phase,
      evaluation: intent.evaluation,
      source_search_experiment_id: intent.source,
      final: intent.evaluation.phase === "final",
      fit: null,
      predict: null,
    });
  }
  update(value: unknown) {
    if (!this.frozen) throw new Error("Unaccepted confirmation");
    const expected = confirmationResult(
        this.candidates,
        [...this.results.values()].filter((e) => e.phase === "confirmation"),
        this.protocol,
        this.plan,
      ),
      actual = obj(value);
    if (actual.status === "incomplete" && expected.status === "pending") {
      same(
        actual,
        {
          ...expected,
          status: "incomplete",
          selected_experiment_id: null,
          ranking: [],
          reason: str(actual.reason, "confirmation failure"),
        },
        "Incomplete confirmation",
      );
      this.confirmation = {
        ...expected,
        status: "incomplete",
        reason: str(actual.reason, "confirmation failure"),
      };
    } else {
      same(actual, expected, "Confirmation ranking");
      this.confirmation = expected;
    }
  }
  finish() {
    same(
      this.manifest.confirmation,
      this.confirmation,
      "Confirmation snapshot",
    );
    same(
      this.manifest.selected_experiment_id,
      this.confirmation?.selected_experiment_id ?? null,
      "Selected experiment",
    );
    if (
      this.manifest.status === "completed" &&
      (!this.confirmation ||
        !["disabled", "complete"].includes(this.confirmation.status) ||
        ![...this.results.values()].some(
          (e) =>
            e.final &&
            e.status === "completed" &&
            e.source_search_experiment_id ===
              this.confirmation?.selected_experiment_id,
        ))
    )
      throw new Error("Incomplete final delivery selection");
  }
}
