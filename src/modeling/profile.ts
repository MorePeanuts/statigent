import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describeFile } from "../evaluation/files";
import { command, commandEnvironment } from "../evaluation/process";
import { integer, keys, obj, str } from "../models/validation";
import { sha256 } from "../records/store";
import { csv, type Dataset, datasetProtocol, select, type Table } from "./data";

export const PROFILE_VERSION = "basic-profile-v1";
export const PROFILE_MAX_BYTES = 1024 * 1024;
export function profileIdentity(dataset: Dataset) {
  return {
    train_sha256: dataset.files[0]?.sha256,
    members_sha256: sha256(Buffer.from(JSON.stringify(dataset.split.train))),
    split_sha256: dataset.split.sha256,
    protocol_sha256: datasetProtocol(dataset).protocol_sha256,
  };
}
export function validateBasicProfile(value: unknown, dataset: Dataset) {
  const x = obj(value);
  keys(x, [
    "generator",
    "identity",
    "rows",
    "column_count",
    "missing_policy",
    "limits",
    "columns",
  ]);
  const identity = obj(x.identity);
  const expected = profileIdentity(dataset);
  keys(identity, Object.keys(expected));
  if (
    Object.entries(expected).some(([key, v]) => identity[key] !== v) ||
    x.generator !== PROFILE_VERSION ||
    x.rows !== dataset.split.train.length ||
    x.missing_policy !== "empty-string-only"
  )
    throw new Error("Profile identity mismatch");
  const limits = obj(x.limits);
  keys(limits, ["columns", "category_values", "text_characters"]);
  if (
    limits.columns !== 128 ||
    limits.category_values !== 10 ||
    limits.text_characters !== 128
  )
    throw new Error("Profile limits mismatch");
  if (
    !Array.isArray(x.columns) ||
    x.columns.length > 128 ||
    x.column_count !== x.columns.length
  )
    throw new Error("Invalid profile columns");
  const names = new Set<string>();
  const columns = x.columns.map((raw: unknown) => {
    const c = obj(raw);
    keys(c, [
      "name",
      "role",
      "type",
      "missing",
      "unique",
      "numeric_parse_failures",
      "quantiles",
      "categories",
      "omitted_categories",
    ]);
    const name = str(c.name, "column name");
    if (name.length > 256 || names.has(name))
      throw new Error("Invalid profile column");
    names.add(name);
    const role =
      name === dataset.target
        ? "target"
        : name === dataset.id_column
          ? "id"
          : "feature";
    if (c.role !== role || (c.type !== "numeric" && c.type !== "categorical"))
      throw new Error("Invalid profile column semantics");
    const missing = integer(c.missing, "missing", 0),
      unique = integer(c.unique, "unique", 0),
      failures = integer(c.numeric_parse_failures, "parse failures", 0),
      omitted = integer(c.omitted_categories, "omitted categories", 0);
    const present = dataset.split.train.length - missing;
    if (present < 0 || unique > present || failures > present)
      throw new Error("Invalid profile counts");
    const quantiles = c.quantiles;
    if (c.type === "numeric") {
      if (
        failures ||
        !Array.isArray(quantiles) ||
        quantiles.length !== 5 ||
        quantiles.some(
          (v, i) =>
            typeof v !== "number" ||
            !Number.isFinite(v) ||
            (i > 0 && v < quantiles[i - 1]),
        )
      )
        throw new Error("Invalid numeric profile");
    } else if (quantiles !== null) throw new Error("Categorical quantiles");
    if (
      !Array.isArray(c.categories) ||
      c.categories.length !== Math.min(10, unique) ||
      omitted !== unique - c.categories.length
    )
      throw new Error("Invalid category truncation");
    const categories = c.categories.map((item: unknown) => {
      const f = obj(item);
      keys(f, ["value", "count", "omitted_characters"]);
      if (typeof f.value !== "string" || [...f.value].length > 128)
        throw new Error("Invalid category text");
      return {
        value: f.value,
        count: integer(f.count, "category count"),
        omitted_characters: integer(
          f.omitted_characters,
          "omitted characters",
          0,
        ),
      };
    });
    if (categories.reduce((n, c) => n + c.count, 0) > present)
      throw new Error("Invalid category frequencies");
    return {
      name,
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
  if (
    names.size !== dataset.features.length + 2 ||
    [...dataset.features, dataset.target, dataset.id_column].some(
      (n) => !names.has(n),
    )
  )
    throw new Error("Profile schema mismatch");
  return {
    generator: PROFILE_VERSION,
    identity: expected,
    rows: dataset.split.train.length,
    column_count: columns.length,
    missing_policy: "empty-string-only",
    limits: { columns: 128, category_values: 10, text_characters: 128 },
    columns,
  };
}
export type BasicProfile = ReturnType<typeof validateBasicProfile>;

export async function createBasicProfile(o: {
  root: string;
  dataset: Dataset;
  train: Table;
  timeout_ms: number;
  signal?: AbortSignal;
  execute?: typeof command;
}) {
  const started = performance.now(),
    request_id = randomUUID(),
    root = resolve(o.root, "basic-profile");
  await mkdir(root);
  try {
    o.signal?.throwIfAborted();
    // Only the internal fit members are materialized; the child has no test path.
    const table = select(o.train, o.dataset.split.train, o.dataset.id_column);
    await writeFile(join(root, "train.csv"), csv(table), {
      flag: "wx",
      mode: 0o444,
    });
    const input = {
      ...(await describeFile(root, "train.csv")),
      path: join(root, "train.csv"),
    };
    const request = {
      version: 1,
      request_id,
      protocol: datasetProtocol(o.dataset),
      id_column: o.dataset.id_column,
      target: o.dataset.target,
      input,
      identity: profileIdentity(o.dataset),
    };
    const timeout =
      Math.min(30000, o.timeout_ms) - (performance.now() - started);
    if (timeout <= 0) throw new Error("Profile deadline");
    await writeFile(join(root, "request.json"), JSON.stringify(request), {
      flag: "wx",
    });
    const env = commandEnvironment();
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    const result = await (o.execute ?? command)(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "python",
        "-m",
        "statigent_modeling.profile",
      ],
      {
        input: JSON.stringify(request),
        signal: o.signal,
        timeout_ms: Math.max(1, Math.floor(timeout)),
        stdout_limit: PROFILE_MAX_BYTES,
        stderr_limit: 65536,
        env: { ...env, PYTHONPATH: resolve("python") },
      },
    );
    const response = obj(JSON.parse(result.stdout));
    keys(response, ["version", "request_id", "ok", "profile", "error"]);
    if (
      response.version !== 1 ||
      response.request_id !== request_id ||
      typeof response.ok !== "boolean"
    )
      throw new Error("Profile response identity mismatch");
    if (!response.ok) throw new Error(str(response.error, "profile error"));
    if (response.error !== undefined)
      throw new Error("Conflicting profile response");
    const profile = validateBasicProfile(response.profile, o.dataset);
    await writeFile(join(root, "profile.json"), JSON.stringify(profile), {
      flag: "wx",
      mode: 0o444,
    });
    return {
      profile,
      artifact: {
        ...(await describeFile(root, "profile.json")),
        path: "basic-profile/profile.json",
      },
      elapsed_ms: performance.now() - started,
    };
  } catch (error) {
    await writeFile(
      join(root, "failure.json"),
      JSON.stringify({
        request_id,
        error: String(error),
        elapsed_ms: performance.now() - started,
      }),
      { flag: "wx" },
    );
    throw new Error(`profile_failure:${String(error)}`);
  }
}
