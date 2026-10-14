import { describeFile } from "../evaluation/files";
import { integer, keys, obj, str, strings } from "../models/validation";
import { sha256 } from "../records/store";
import { parseCsv, rowIds, type Table } from "./data";
import type { DatasetV3 } from "./dataset-v3";
import { byteOrder } from "./protocol";
import { type ProtocolV2, validateProtocolV2 } from "./protocol-v2";
import { selectFileV2 } from "./table-ops";
import { derivedSeed, evaluation, type ValidationPlan } from "./validation";

export async function validationPlanFromFilesV2(
  sourceRoot: string,
  dataset: DatasetV3,
  mode: ValidationPlan["mode"],
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "statigent-plan-v2-")),
  );
  try {
    const members = await loadSearchMembersV2(sourceRoot, dataset);
    const selected = await selectFileV2({
      root,
      source: {
        ...dataset.training,
        path: resolve(sourceRoot, dataset.training.path),
      },
      columns: [
        dataset.protocol.id_column,
        ...dataset.protocol.targets.map((t) => t.name),
      ],
      members: null,
      limits: dataset.limits,
      timeout_ms: 60000,
    });
    if (selected.file.bytes * 16 > dataset.limits.max_memory_bytes)
      throw new Error("Validation metadata memory limit");
    return createValidationPlanV2(
      dataset,
      parseCsv(await readFile(selected.file.path, "utf8")),
      members,
      mode,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export type MembersV2 = {
  train: string[];
  validation: string[];
  sha256: string;
};
function memberHash(train: string[], validation: string[]) {
  return sha256(Buffer.from(JSON.stringify({ train, validation })));
}
function labelIndex(labels: Table, p: ProtocolV2) {
  validateProtocolV2(p);
  if (
    JSON.stringify(labels.columns) !==
      JSON.stringify([p.id_column, ...p.targets.map((t) => t.name)]) ||
    labels.rows.some((row) => row.length !== labels.columns.length)
  )
    throw new Error("Expected only identity and all targets");
  const ids = rowIds(labels, p.id_column);
  for (const row of labels.rows)
    for (let i = 0; i < p.targets.length; i++) {
      const target = p.targets[i],
        value = row[i + 1];
      if (
        !target ||
        typeof value !== "string" ||
        !value.trim() ||
        (p.kind === "regression"
          ? !Number.isFinite(Number(value))
          : !target.classes.includes(value))
      )
        throw new Error("Unknown or missing target value");
    }
  return { ids, byId: new Map(labels.rows.map((row) => [row[0] ?? "", row])) };
}
export function assertMembersV2(
  labels: Table,
  p: ProtocolV2,
  members: MembersV2,
) {
  const { ids, byId } = labelIndex(labels, p),
    all = [...members.train, ...members.validation];
  if (
    !members.train.length ||
    !members.validation.length ||
    all.length !== ids.length ||
    new Set(all).size !== all.length ||
    all.some((id) => !byId.has(id)) ||
    memberHash(members.train, members.validation) !== members.sha256
  )
    throw new Error("Invalid split members/hash");
  if (p.metric.id === "r2-sklearn-v1" && members.validation.length < 2)
    throw new Error("R2 requires two validation members");
  if (p.kind !== "regression")
    for (let i = 0; i < p.targets.length; i++) {
      const target = p.targets[i];
      if (!target) throw new Error("Missing target");
      for (const partition of ["train", "validation"] as const) {
        const present = new Set(
          members[partition].map((id) => byId.get(id)?.[i + 1]),
        );
        if (target.classes.some((c) => !present.has(c)))
          throw new Error(`Class coverage failed: ${target.name}/${partition}`);
      }
    }
}
export function fixedSplitV2(
  labels: Table,
  p: ProtocolV2,
  seed: number,
): MembersV2 {
  integer(seed, "split seed", 0);
  const { ids } = labelIndex(labels, p);
  const groups =
    p.kind === "regression" || p.kind === "multilabel"
      ? [ids]
      : p.targets[0]?.classes.map((label) =>
          labels.rows
            .filter((row) => row[1] === label)
            .map((row) => str(row[0], "ID")),
        );
  if (!groups) throw new Error("Missing class groups");
  const train: string[] = [],
    validation: string[] = [];
  for (const group of groups) {
    if (group.length < 2) throw new Error("Cannot split rare class");
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
    train.push(...ordered.slice(n));
  }
  const members = { train, validation, sha256: memberHash(train, validation) };
  assertMembersV2(labels, p, members);
  return members;
}
export async function loadSearchMembersV2(
  root: string,
  dataset: DatasetV3,
): Promise<MembersV2> {
  const ref = dataset.split.file,
    actual = await describeFile(root, ref.path);
  if (
    actual.bytes !== ref.bytes ||
    actual.sha256 !== ref.sha256 ||
    actual.bytes > dataset.limits.max_file_bytes ||
    actual.bytes * 8 > dataset.limits.max_memory_bytes
  )
    throw new Error("Search split file identity/limit mismatch");
  const raw = obj(await Bun.file(`${root}/${ref.path}`).json());
  keys(raw, ["version", "method", "seed", "train", "validation", "sha256"]);
  const train = strings(raw.train, "train members"),
    validation = strings(raw.validation, "validation members");
  if (
    raw.version !== 1 ||
    raw.method !== dataset.split.method ||
    raw.seed !== dataset.seed ||
    train.length !== dataset.split.train_rows ||
    validation.length !== dataset.split.validation_rows ||
    raw.sha256 !== memberHash(train, validation)
  )
    throw new Error("Search split metadata mismatch");
  return { train, validation, sha256: str(raw.sha256, "members SHA256") };
}
export function createValidationPlanV2(
  dataset: DatasetV3,
  labels: Table,
  searchMembers: MembersV2,
  mode: ValidationPlan["mode"],
): ValidationPlan {
  if (mode !== "none" && mode !== "terminal_repeated_holdout")
    throw new Error("Unknown confirmation mode");
  if (labels.rows.length !== dataset.rows.training)
    throw new Error("Training label count mismatch");
  assertMembersV2(labels, dataset.protocol, searchMembers);
  if (
    searchMembers.train.length !== dataset.split.train_rows ||
    searchMembers.validation.length !== dataset.split.validation_rows ||
    (dataset.split.method !== "explicit-v1" &&
      fixedSplitV2(labels, dataset.protocol, dataset.seed).sha256 !==
        searchMembers.sha256)
  )
    throw new Error("Frozen search split mismatch");
  const search = evaluation(dataset, "search", searchMembers, dataset.seed);
  const seen = new Set([
    JSON.stringify([...searchMembers.validation].sort(byteOrder)),
  ]);
  const confirmation: ValidationPlan["confirmation"] = [];
  if (mode === "terminal_repeated_holdout")
    for (const index of [0, 1]) {
      const seed = derivedSeed(dataset.seed, index, "split");
      const members = fixedSplitV2(labels, dataset.protocol, seed);
      const signature = JSON.stringify([...members.validation].sort(byteOrder));
      if (seen.has(signature))
        throw new Error(
          "Confirmation split duplicates existing split; no automatic reseeding",
        );
      seen.add(signature);
      confirmation.push(
        evaluation(
          dataset,
          "confirmation",
          members,
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
      {
        train: rowIds(labels, dataset.protocol.id_column).sort(byteOrder),
        validation: [],
      },
      dataset.seed,
    ),
  };
}

import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
