import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { regular, verifyFiles } from "../evaluation/files";
import { integer, obj, str } from "../models/validation";
import { readManifest, safeRelativePath } from "../records/store";
import { inspectWorkflow } from "./audit-v4";
import { validateBenchmarkModelingTask } from "./config";
import { parseDatasetV3 } from "./dataset-v3";
import { loadFrozenModel } from "./frozen-model";
import { validateProtocolV2 } from "./protocol-v2";

function same(actual: unknown, expected: unknown, label: string) {
  if (!isDeepStrictEqual(actual, expected))
    throw new Error(`${label} mismatch`);
}
function list(v: unknown) {
  if (!Array.isArray(v)) throw new Error("Expected record list");
  return v.map(obj);
}
function file(v: unknown) {
  const f = obj(v);
  return {
    path: safeRelativePath(str(f.path, "file path")),
    bytes: integer(f.bytes, "file bytes", 0),
    sha256: str(f.sha256, "file SHA256"),
  };
}
async function auditStage(
  root: string,
  value: unknown,
  codeHash: string,
  protocolHash: string,
  featureHash: string,
  modelSeed: number,
  kind: "fit" | "predict",
) {
  const s = obj(value),
    id = str(s.run_id, "stage ID");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid stage ID");
  const directory = resolve(root, "stages", id),
    input = resolve(root, "inputs", id);
  same(s.directory, directory, "Stage directory");
  same(s.stage_version, 4, "Stage version");
  const native = await readManifest(directory);
  same(native.run_id, id, "Native stage ID");
  same(native.status, s.status, "Native stage status");
  same(native.image.id, obj(s.image).id, "Native stage image");
  same(native.config.input_root, input, "Stage input root");
  same(native.seed, modelSeed, "Stage model seed");
  same(native.model, "not_applicable", "Stage has no LLM");
  if (
    !native.inputs.length &&
    s.status === "failed" &&
    s.execution_confirmed === false
  ) {
    same(s.output, null, "Unstarted stage output");
    if (s.metadata !== undefined) throw new Error("Unstarted stage metadata");
    return;
  }
  same(
    native.inputs.map((f) => f.path),
    kind === "fit"
      ? ["candidate.py", "stage.json", "data.csv", "features.json"]
      : [
          "candidate.py",
          "stage.json",
          "model.joblib",
          "data.csv",
          "features.json",
        ],
    "Stage whitelist",
  );
  await verifyFiles(
    input,
    native.inputs.map((f) => ({
      path: f.path,
      bytes: f.size_bytes,
      sha256: f.sha256,
    })),
  );
  same(
    native.inputs.find((f) => f.path === "candidate.py")?.sha256,
    codeHash,
    "Stage candidate code",
  );
  same(
    native.inputs.find((f) => f.path === "features.json")?.sha256,
    featureHash,
    "Stage full feature schema",
  );
  const config = obj(
    JSON.parse(await readFile(await regular(input, "stage.json"), "utf8")),
  );
  same(config.schema_version, 4, "Stage config version");
  same(
    validateProtocolV2(config.protocol).protocol_sha256,
    protocolHash,
    "Stage target protocol",
  );
  same(config.seed, modelSeed, "Stage config seed");
  for (const key of ["data", "feature_schema"]) {
    const ref = file(config[key]);
    same(
      ref,
      native.inputs
        .filter((f) => f.path === ref.path)
        .map((f) => ({
          path: f.path,
          bytes: f.size_bytes,
          sha256: f.sha256,
        }))[0],
      "Stage data contract",
    );
  }
  for (const [key, name] of [
    ["output", kind === "fit" ? "model.joblib" : "predictions.csv"],
    ["metadata", "model-metadata.json"],
  ] as const) {
    if (s[key] === undefined || s[key] === null) {
      if (s.status === "completed" && (key === "output" || kind === "fit"))
        throw new Error("Missing successful stage artifact");
      continue;
    }
    const ref = file(s[key]);
    const artifact = native.artifacts.find(
      (a) => a.path === ref.path && a.source_path === name && a.complete,
    );
    if (
      !artifact ||
      artifact.sha256 !== ref.sha256 ||
      artifact.size_bytes !== ref.bytes
    )
      throw new Error("Stage artifact identity mismatch");
    await verifyFiles(directory, [ref]);
  }
  if (s.status === "completed") {
    same(s.execution_confirmed, true, "Successful stage confirmation");
    same(
      native.workspace_collection.status,
      "complete",
      "Successful stage cleanup",
    );
  }
}

export async function inspectWorkflowV5(
  directory: string,
  manifest: Record<string, unknown>,
  events: Record<string, unknown>[],
  payloads: Map<number, unknown>,
) {
  const config = obj(manifest.config),
    task = validateBenchmarkModelingTask(config.task),
    dataset = parseDatasetV3(config.dataset);
  const view = await inspectWorkflow(directory, manifest, events, payloads);
  for (const e of list(manifest.experiments)) {
    const codeHash = str(e.code_sha256, "code hash"),
      seed = integer(obj(e.evaluation).model_seed, "model seed", 0);
    for (const key of ["fit", "predict"] as const)
      if (e[key] !== null)
        await auditStage(
          directory,
          e[key],
          codeHash,
          dataset.protocol.protocol_sha256,
          dataset.feature_schema.sha256,
          seed,
          key,
        );
    if (e.training_diagnostic !== undefined) {
      const d = obj(e.training_diagnostic);
      if (d.prediction !== null)
        await auditStage(
          directory,
          d.prediction,
          codeHash,
          dataset.protocol.protocol_sha256,
          dataset.feature_schema.sha256,
          seed,
          "predict",
        );
    }
    if (e.final === true && e.status === "completed") {
      same(e.reason, "model_frozen", "Final fit state");
      same(e.predict, null, "Fit-only final stage");
    }
  }
  const freezeEvents = events.filter((e) => e.type === "model_frozen"),
    predictionEvents = events.filter(
      (e) => e.type === "frozen_prediction_result",
    );
  if (freezeEvents.length > 1 || predictionEvents.length > 1)
    throw new Error("Repeated native freeze/prediction");
  const success =
    manifest.status === "completed" || manifest.status === "model_frozen";
  if (!freezeEvents.length) {
    if (success || predictionEvents.length)
      throw new Error("Missing frozen model");
    return view;
  }
  const freeze = freezeEvents[0];
  if (!freeze) throw new Error("Missing freeze event");
  const sequence = integer(freeze.sequence, "freeze sequence");
  if (
    events.some(
      (e) =>
        Number(e.sequence) > sequence &&
        ["model_request", "experiment_intent", "action_accepted"].includes(
          String(e.type),
        ),
    )
  )
    throw new Error("Modeling continued after model freeze");
  const frozen = await loadFrozenModel(directory);
  same(payloads.get(sequence), frozen, "Frozen model journal");
  same(frozen.dataset, dataset, "Frozen dataset");
  same(frozen.task, task, "Frozen task");
  same(
    frozen.selected_experiment_id,
    manifest.selected_experiment_id,
    "Frozen selection",
  );
  const final = list(manifest.experiments).find(
    (e) => e.id === frozen.final_experiment_id,
  );
  if (!final || final.status !== "completed" || final.final !== true)
    throw new Error("Missing frozen final fit");
  same(
    obj(obj(final.fit).output).sha256,
    frozen.model.sha256,
    "Frozen model bytes",
  );
  same(final.code_sha256, frozen.code.sha256, "Frozen code bytes");
  const completedFinal = events.find(
    (e) => e.type === "experiment_result" && e.experiment_id === final.id,
  );
  if (!completedFinal || Number(completedFinal.sequence) >= sequence)
    throw new Error("Model frozen before final fit result");
  let prediction: Record<string, unknown> | null = null;
  if (predictionEvents.length) {
    const event = predictionEvents[0];
    if (!event || Number(event.sequence) <= sequence)
      throw new Error("Prediction before model freeze");
    prediction = obj(payloads.get(Number(event.sequence)));
    const id = str(prediction.run_id, "prediction ID");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new Error("Invalid prediction ID");
    const root = resolve(directory, "predictions", id);
    same(prediction.directory, root, "Prediction directory");
    same(
      JSON.parse(
        await readFile(await regular(root, "prediction.json"), "utf8"),
      ),
      prediction,
      "Prediction journal",
    );
    same(prediction.frozen_id, frozen.frozen_id, "Prediction frozen identity");
    same(
      prediction.model_sha256,
      frozen.model.sha256,
      "Prediction model identity",
    );
    same(obj(prediction.calls).models, 0, "No model calls during prediction");
    same(obj(prediction.calls).fits, 0, "No fit during prediction");
    if (prediction.stage !== null)
      await auditStage(
        root,
        prediction.stage,
        frozen.code.sha256,
        dataset.protocol.protocol_sha256,
        dataset.feature_schema.sha256,
        frozen.model_seed,
        "predict",
      );
    if (prediction.status === "completed") {
      same(obj(prediction.calls).predictions, 1, "Prediction count");
      const s = obj(prediction.stage),
        output = file(s.output),
        result = obj(prediction.predictions);
      same(
        result,
        {
          ...output,
          path: resolve(str(s.directory, "stage directory"), output.path),
        },
        "Canonical prediction identity",
      );
      same(
        prediction.execution_confirmed,
        true,
        "Prediction execution confirmation",
      );
    }
  }
  if (task.delivery_mode === "fit_only" && prediction)
    throw new Error("fit_only dispatched prediction");
  if (success) {
    const delivery = obj(obj(manifest.delivery).artifact);
    same(
      JSON.parse(
        await readFile(
          await regular(directory, "delivery/delivery.json"),
          "utf8",
        ),
      ),
      delivery,
      "Delivery manifest",
    );
    same(delivery.schema_version, 5, "Delivery version");
    same(delivery.frozen, frozen, "Delivery frozen model");
    same(delivery.prediction, prediction, "Delivery prediction");
    same(delivery.confirmation, manifest.confirmation, "Delivery confirmation");
    same(
      delivery.validation_plan,
      config.validation_plan,
      "Delivery evaluation plan",
    );
    if (
      task.delivery_mode === "fit_predict" &&
      prediction?.status !== "completed"
    )
      throw new Error("Missing successful prediction delivery");
    same(
      manifest.status,
      task.delivery_mode === "fit_only" ? "model_frozen" : "completed",
      "Delivery mode outcome",
    );
  }
  return view;
}
