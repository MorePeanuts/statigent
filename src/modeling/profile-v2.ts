import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { describeFile, regular, verifyFiles } from "../evaluation/files";
import { command, commandEnvironment } from "../evaluation/process";
import { integer, keys, obj, str } from "../models/validation";
import { sha256 } from "../records/store";
import type { DatasetV3 } from "./dataset-v3";
import { canonicalJson } from "./protocol-v2";
import { selectFileV2 } from "./table-ops";
import type { MembersV2 } from "./validation-v2";

export async function recordedProfileV2(
  root: string,
  dataset: DatasetV3,
  members: MembersV2,
  value: unknown,
) {
  const request = obj(
    JSON.parse(
      await readFile(await regular(root, "basic-profile/request.json"), "utf8"),
    ),
  );
  const input = obj(request.input),
    path = relative(resolve(root), str(input.path, "profile input"));
  if (!path.startsWith("basic-profile/selections/"))
    throw new Error("Invalid profile snapshot path");
  const snapshot = {
    path,
    bytes: integer(input.bytes, "snapshot bytes"),
    sha256: str(input.sha256, "snapshot SHA256"),
  };
  await verifyFiles(root, [
    snapshot,
    { ...dataset.feature_schema, path: "basic-profile/features.json" },
  ]);
  return validateBasicProfileV2(value, dataset, members, snapshot.sha256);
}

export function validateBasicProfileV2(
  value: unknown,
  dataset: DatasetV3,
  members: MembersV2,
  snapshotSha: string,
) {
  const p = dataset.protocol,
    raw = obj(value),
    identity = obj(raw.identity);
  keys(raw, [
    "generator",
    "identity",
    "rows",
    "column_count",
    "missing_policy",
    "limits",
    "columns",
    "omitted_columns",
    "targets",
    "full_feature_schema",
  ]);
  const expected = {
    train_sha256: dataset.training.sha256,
    members_sha256: sha256(Buffer.from(JSON.stringify(members.train))),
    split_sha256: members.sha256,
    protocol_sha256: p.protocol_sha256,
    feature_schema_sha256: dataset.feature_schema.sha256,
    snapshot_sha256: snapshotSha,
  };
  if (
    canonicalJson(identity) !== canonicalJson(expected) ||
    !/^[a-f0-9]{64}$/.test(snapshotSha) ||
    raw.generator !== "basic-profile-v2" ||
    raw.rows !== members.train.length ||
    raw.missing_policy !== "escaped-null-v1"
  )
    throw new Error("Profile identity mismatch");
  const limits = { columns: 128, category_values: 10, text_characters: 128 };
  if (
    canonicalJson(raw.limits) !== canonicalJson(limits) ||
    canonicalJson(raw.targets) !== canonicalJson(p.targets)
  )
    throw new Error("Profile target/limits mismatch");
  const fullSchema = {
    ...dataset.feature_schema,
    path: "basic-profile/features.json",
  };
  if (canonicalJson(raw.full_feature_schema) !== canonicalJson(fullSchema))
    throw new Error("Full feature schema mismatch");
  const names = [
      p.id_column,
      ...p.targets.map((t) => t.name),
      ...p.feature_columns,
    ],
    sourceOrder = [
      p.id_column,
      ...p.feature_columns,
      ...p.targets.map((t) => t.name),
    ];
  if (
    !Array.isArray(raw.columns) ||
    raw.column_count !== names.length ||
    raw.columns.length !== Math.min(128, names.length) ||
    raw.omitted_columns !== names.length - raw.columns.length
  )
    throw new Error("Profile column truncation mismatch");
  const columns = raw.columns.map((value, index) => {
    const c = obj(value),
      name = names[index];
    if (!name) throw new Error("Unexpected profile column");
    keys(c, [
      "name",
      "omitted_name_characters",
      "source_index",
      "role",
      "type",
      "missing",
      "unique",
      "numeric_parse_failures",
      "quantiles",
      "categories",
      "omitted_categories",
    ]);
    const role =
      name === p.id_column
        ? "id"
        : p.targets.some((t) => t.name === name)
          ? "target"
          : "feature";
    if (
      c.name !== [...name].slice(0, 256).join("") ||
      c.omitted_name_characters !== Math.max(0, [...name].length - 256) ||
      c.source_index !== sourceOrder.indexOf(name) ||
      c.role !== role ||
      (c.type !== "numeric" && c.type !== "categorical")
    )
      throw new Error("Profile column identity mismatch");
    const missing = integer(c.missing, "missing", 0),
      unique = integer(c.unique, "unique", 0),
      failures = integer(c.numeric_parse_failures, "parse failures", 0),
      omitted = integer(c.omitted_categories, "omitted categories", 0),
      present = members.train.length - missing;
    if (present < 0 || unique > present || failures > present)
      throw new Error("Profile count mismatch");
    let quantiles: number[] | null = null;
    if (c.type === "numeric") {
      if (failures || !Array.isArray(c.quantiles) || c.quantiles.length !== 5)
        throw new Error("Invalid numeric profile");
      quantiles = c.quantiles.map((v) => {
        if (typeof v !== "number" || !Number.isFinite(v))
          throw new Error("Invalid quantile");
        return v;
      });
      if (quantiles.some((v, i) => i > 0 && v < (quantiles?.[i - 1] ?? v)))
        throw new Error("Unordered quantiles");
    } else if (c.quantiles !== null) throw new Error("Categorical quantiles");
    if (
      !Array.isArray(c.categories) ||
      c.categories.length !== Math.min(unique, 10) ||
      omitted !== unique - c.categories.length
    )
      throw new Error("Category truncation mismatch");
    const categories = c.categories.map((value) => {
      const category = obj(value);
      keys(category, ["value", "count", "omitted_characters"]);
      if (
        typeof category.value !== "string" ||
        [...category.value].length > 128
      )
        throw new Error("Invalid category text");
      return {
        value: category.value,
        count: integer(category.count, "category count"),
        omitted_characters: integer(
          category.omitted_characters,
          "omitted characters",
          0,
        ),
      };
    });
    if (categories.reduce((n, c) => n + c.count, 0) > present)
      throw new Error("Invalid category frequencies");
    return {
      name: String(c.name),
      omitted_name_characters: Math.max(0, [...name].length - 256),
      source_index: sourceOrder.indexOf(name),
      role,
      type: c.type,
      missing,
      unique,
      numeric_parse_failures: failures,
      quantiles,
      categories,
      omitted_categories: omitted,
    };
  });
  return {
    generator: "basic-profile-v2" as const,
    identity: expected,
    rows: members.train.length,
    column_count: names.length,
    missing_policy: "escaped-null-v1" as const,
    limits,
    columns,
    omitted_columns: names.length - columns.length,
    targets: p.targets,
    full_feature_schema: fullSchema,
  };
}
export type BasicProfileV2 = ReturnType<typeof validateBasicProfileV2>;
export async function createBasicProfileV2(o: {
  root: string;
  sourceRoot: string;
  dataset: DatasetV3;
  members: MembersV2;
  timeout_ms: number;
  signal?: AbortSignal;
  execute?: typeof command;
}) {
  const began = performance.now(),
    request_id = randomUUID(),
    root = resolve(o.root, "basic-profile");
  await mkdir(root);
  try {
    const p = o.dataset.protocol;
    const selected = await selectFileV2({
      root,
      source: {
        ...o.dataset.training,
        path: resolve(o.sourceRoot, o.dataset.training.path),
      },
      columns: [
        p.id_column,
        ...p.feature_columns,
        ...p.targets.map((t) => t.name),
      ],
      members: o.members.train,
      limits: o.dataset.limits,
      timeout_ms: o.timeout_ms,
      signal: o.signal,
      execute: o.execute,
    });
    await verifyFiles(o.sourceRoot, [o.dataset.feature_schema]);
    await copyFile(
      resolve(o.sourceRoot, o.dataset.feature_schema.path),
      resolve(root, "features.json"),
      constants.COPYFILE_EXCL,
    );
    await chmod(resolve(root, "features.json"), 0o444);
    const schema = {
      ...(await describeFile(root, "features.json")),
      path: resolve(root, "features.json"),
    };
    const identity = {
      train_sha256: o.dataset.training.sha256,
      members_sha256: selected.members_sha256,
      split_sha256: o.members.sha256,
      protocol_sha256: p.protocol_sha256,
      feature_schema_sha256: schema.sha256,
      snapshot_sha256: selected.file.sha256,
    };
    const request = {
      version: 2,
      request_id,
      protocol: p,
      input: selected.file,
      feature_schema: schema,
      identity,
      limits: o.dataset.limits,
    };
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 1024 * 1024)
      throw new Error("Profile request too large");
    await writeFile(resolve(root, "request.json"), input, { flag: "wx" });
    const remaining = Math.floor(o.timeout_ms - (performance.now() - began));
    if (remaining <= 0) throw new Error("Profile deadline");
    const env = commandEnvironment();
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    const response = await (o.execute ?? command)(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-m",
        "statigent_modeling.profile_v2",
      ],
      {
        input,
        signal: o.signal,
        timeout_ms: remaining,
        stdout_limit: 1024 * 1024,
        stderr_limit: 65536,
        env: { ...env, PYTHONPATH: resolve("python") },
      },
    );
    const raw = obj(JSON.parse(response.stdout));
    keys(raw, ["version", "request_id", "ok", "profile", "error"]);
    if (
      raw.version !== 2 ||
      raw.request_id !== request_id ||
      typeof raw.ok !== "boolean"
    )
      throw new Error("Profile response identity mismatch");
    if (!raw.ok) throw new Error(str(raw.error, "profile error"));
    if (raw.error !== undefined)
      throw new Error("Conflicting profile response");
    const profile = validateBasicProfileV2(
      raw.profile,
      o.dataset,
      o.members,
      selected.file.sha256,
    );
    await writeFile(resolve(root, "profile.json"), JSON.stringify(profile), {
      flag: "wx",
      mode: 0o444,
    });
    return {
      profile,
      artifact: {
        ...(await describeFile(root, "profile.json")),
        path: "basic-profile/profile.json",
      },
      schema_artifact: { ...schema, path: "basic-profile/features.json" },
      elapsed_ms: performance.now() - began,
    };
  } catch (error) {
    await writeFile(
      resolve(root, "failure.json"),
      JSON.stringify({
        request_id,
        error: String(error),
        elapsed_ms: performance.now() - began,
      }),
      { flag: "wx" },
    );
    throw new Error(`profile_failure:${String(error)}`);
  }
}
