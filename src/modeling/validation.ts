import { sha256 } from "../records/store";
import { type Dataset, datasetProtocol, rowIds, type Table } from "./data";
import { byteOrder } from "./protocol";
export type ExperimentPhase = "search" | "confirmation" | "final";
export interface Evaluation {
  evaluation_id: string;
  phase: ExperimentPhase;
  model_seed: number;
  split_seed: number;
  split_method: string;
  split: Dataset["split"];
  protocol_sha256: string;
  train_sha256: string;
}
export interface ValidationPlan {
  version: 1;
  algorithm: "terminal-holdout-v1";
  mode: "none" | "terminal_repeated_holdout";
  search: Evaluation;
  confirmation: Evaluation[];
  final: Evaluation;
}
export function derivedSeed(
  seed: number,
  index: number,
  purpose: "split" | "model",
) {
  return (
    Number.parseInt(
      sha256(
        Buffer.from(`terminal-holdout-v1:${seed}:${index}:${purpose}`),
      ).slice(0, 8),
      16,
    ) % 2147483647
  );
}
export function evaluation(
  dataset: Dataset,
  phase: ExperimentPhase,
  members: { train: string[]; validation: string[] },
  model_seed: number,
  split_seed = dataset.seed,
): Evaluation {
  const split = {
    ...members,
    sha256: sha256(
      Buffer.from(
        JSON.stringify({
          train: members.train,
          validation: members.validation,
        }),
      ),
    ),
  };
  const identity = {
    phase,
    model_seed,
    split_seed,
    split_method:
      phase === "final"
        ? "all-training-v1"
        : phase === "search"
          ? (dataset.split_method ?? "hash-v1")
          : dataset.kind === "regression"
            ? "hash-v1"
            : "stratified-hash-v1",
    split_sha256: split.sha256,
    protocol_sha256: datasetProtocol(dataset).protocol_sha256,
    train_sha256: dataset.files[0]?.sha256 ?? "",
  };
  return {
    evaluation_id: sha256(Buffer.from(JSON.stringify(identity))),
    phase,
    model_seed,
    split_seed: identity.split_seed,
    split_method: identity.split_method,
    split,
    protocol_sha256: identity.protocol_sha256,
    train_sha256: identity.train_sha256,
  };
}
export function createValidationPlan(
  dataset: Dataset,
  train: Table,
  mode: ValidationPlan["mode"],
): ValidationPlan {
  const ids = rowIds(train, dataset.id_column),
    protocol = datasetProtocol(dataset);
  if (
    ids.length !==
      dataset.split.train.length + dataset.split.validation.length ||
    [...dataset.split.train, ...dataset.split.validation].some(
      (id) => !ids.includes(id),
    )
  )
    throw new Error("Validation plan membership mismatch");
  const search = evaluation(dataset, "search", dataset.split, dataset.seed);
  if (search.split.sha256 !== dataset.split.sha256)
    throw new Error("Search split hash mismatch");
  const confirmation: Evaluation[] = [];
  const memberships = new Set([
    JSON.stringify([...dataset.split.validation].sort(byteOrder)),
  ]);
  if (mode === "terminal_repeated_holdout")
    for (const index of [0, 1]) {
      const seed = derivedSeed(dataset.seed, index, "split"),
        targetIndex = train.columns.indexOf(dataset.target),
        idIndex = train.columns.indexOf(dataset.id_column);
      const groups =
        dataset.kind === "regression"
          ? [ids]
          : protocol.classes.map((label) =>
              train.rows
                .filter((r) => r[targetIndex] === label)
                .map((r) => r[idIndex] ?? ""),
            );
      if (groups.flat().length !== ids.length)
        throw new Error("Confirmation target mapping mismatch");
      const fit: string[] = [],
        validation: string[] = [];
      for (const group of groups) {
        if (group.length < 2)
          throw new Error("Confirmation cannot cover a rare class");
        const ordered = [...group].sort(
          (a, b) =>
            byteOrder(
              sha256(Buffer.from(`${seed}:${a}`)),
              sha256(Buffer.from(`${seed}:${b}`)),
            ) || byteOrder(a, b),
        );
        const n = Math.min(
          ordered.length - 1,
          Math.max(1, Math.floor(ordered.length * 0.2)),
        );
        validation.push(...ordered.slice(0, n));
        fit.push(...ordered.slice(n));
      }
      const membership = JSON.stringify([...validation].sort(byteOrder));
      if (memberships.has(membership))
        throw new Error(
          "Confirmation split duplicates search or another confirmation split; no automatic reseeding",
        );
      memberships.add(membership);
      confirmation.push(
        evaluation(
          dataset,
          "confirmation",
          { train: fit, validation },
          derivedSeed(dataset.seed, index, "model"),
          seed,
        ),
      );
    }
  return {
    version: 1,
    algorithm: "terminal-holdout-v1",
    mode,
    search,
    confirmation,
    final: evaluation(
      dataset,
      "final",
      { train: [...ids].sort(byteOrder), validation: [] },
      dataset.seed,
    ),
  };
}
export function assertEvaluation(actual: Evaluation, expected: Evaluation) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Experiment evaluation identity mismatch");
}
