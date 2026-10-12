import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describeFile, regular, verifyFiles } from "../evaluation/files";
import { integer, keys, obj, str, strings } from "../models/validation";
import { sha256, writeJson } from "../records/store";

export const MAX_DATA_BYTES = 32 * 1024 * 1024;
export interface Table {
  columns: string[];
  rows: string[][];
}
/** Strict CSV: quoted newlines are valid; ragged rows and ambiguous headers are not. */
export function parseCsv(text: string): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const input = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === "," || c === "\n") {
      row.push(field);
      field = "";
      closed = false;
      if (c === "\n") {
        rows.push(row);
        row = [];
      }
    } else {
      if (closed || c === '"' || c === "\r" || c === "\0")
        throw new Error("Invalid CSV quoting");
      field += c;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  const columns = rows.shift();
  if (
    !columns?.length ||
    columns.some((c) => !c.trim()) ||
    new Set(columns).size !== columns.length ||
    rows.some((r) => r.length !== columns.length)
  )
    throw new Error("Invalid CSV columns or rows");
  return { columns, rows };
}
export function csv(table: Table): string {
  return `${[table.columns, ...table.rows]
    .map((row) =>
      row
        .map((s) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s))
        .join(","),
    )
    .join("\n")}\n`;
}
export async function tableFile(root: string, path: string): Promise<Table> {
  const p = await regular(root, path);
  if ((await stat(p)).size > MAX_DATA_BYTES)
    throw new Error("Data file too large");
  return parseCsv(await readFile(p, "utf8"));
}
export function finite(value: string): number {
  if (!value.trim() || !Number.isFinite(Number(value)))
    throw new Error("Non-finite numeric value");
  return Number(value);
}
export function rowIds(table: Table, id: string): string[] {
  const index = table.columns.indexOf(id);
  if (index < 0) throw new Error("Missing ID column");
  const ids = table.rows.map((r) => str(r[index], "row ID"));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate row ID");
  return ids;
}
export function select(
  table: Table,
  ids: string[],
  id: string,
  omit: string[] = [],
): Table {
  const order = rowIds(table, id);
  const byId = new Map(order.map((x, i) => [x, table.rows[i]]));
  const indices = table.columns
    .map((_, i) => i)
    .filter((i) => !omit.includes(table.columns[i] ?? ""));
  return {
    columns: indices.map((i) => table.columns[i] ?? ""),
    rows: ids.map((x) => {
      const row = byId.get(x);
      if (!row) throw new Error("Unknown sample ID");
      return indices.map((i) => row[i] ?? "");
    }),
  };
}
export interface Dataset {
  schema_version: 1;
  kind: "regression";
  metric: "rmse";
  direction: "minimize";
  target: string;
  id_column: string;
  seed: number;
  files: { path: string; sha256: string; bytes: number }[];
  split: { train: string[]; validation: string[]; sha256: string };
  features: string[];
}
function splitHash(train: string[], validation: string[]) {
  return sha256(Buffer.from(JSON.stringify({ train, validation })));
}
export function validateDataset(value: unknown): Dataset {
  const x = obj(value);
  keys(x, [
    "schema_version",
    "kind",
    "metric",
    "direction",
    "target",
    "id_column",
    "seed",
    "files",
    "split",
    "features",
  ]);
  if (
    x.schema_version !== 1 ||
    x.kind !== "regression" ||
    x.metric !== "rmse" ||
    x.direction !== "minimize"
  )
    throw new Error("Unsupported regression protocol");
  const s = obj(x.split);
  keys(s, ["train", "validation", "sha256"]);
  const train = strings(s.train, "train IDs"),
    validation = strings(s.validation, "validation IDs");
  if (
    !train.length ||
    !validation.length ||
    new Set([...train, ...validation]).size !==
      train.length + validation.length ||
    s.sha256 !== splitHash(train, validation)
  )
    throw new Error("Invalid frozen split");
  if (!Array.isArray(x.files) || x.files.length !== 2)
    throw new Error("Expected train/test files");
  const files = x.files.map((v: unknown) => {
    const f = obj(v);
    keys(f, ["path", "bytes", "sha256"]);
    const hash = str(f.sha256, "hash");
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid hash");
    return {
      path: str(f.path, "path"),
      sha256: hash,
      bytes: integer(f.bytes, "bytes"),
    };
  });
  if (files[0]?.path !== "train.csv" || files[1]?.path !== "test.csv")
    throw new Error("Invalid dataset paths");
  const features = strings(x.features, "features");
  const target = str(x.target, "target"),
    id = str(x.id_column, "id");
  if (
    !features.length ||
    new Set(features).size !== features.length ||
    features.includes(target) ||
    features.includes(id) ||
    target === id
  )
    throw new Error("Invalid feature/target columns");
  return {
    schema_version: 1,
    kind: "regression",
    metric: "rmse",
    direction: "minimize",
    target,
    id_column: id,
    seed: integer(x.seed, "seed", 0),
    files,
    split: { train, validation, sha256: splitHash(train, validation) },
    features,
  };
}
export async function loadDataset(
  root: string,
): Promise<{ dataset: Dataset; train: Table; test: Table }> {
  const path = await regular(root, "dataset.json");
  if ((await stat(path)).size > MAX_DATA_BYTES)
    throw new Error("Dataset manifest too large");
  const dataset = validateDataset(JSON.parse(await readFile(path, "utf8")));
  await verifyFiles(root, dataset.files);
  const train = await tableFile(root, "train.csv"),
    test = await tableFile(root, "test.csv");
  validateTables(train, test, dataset.target, dataset.id_column);
  const ids = rowIds(train, dataset.id_column);
  if (
    ids.length !==
      dataset.split.train.length + dataset.split.validation.length ||
    [...dataset.split.train, ...dataset.split.validation].some(
      (x) => !ids.includes(x),
    ) ||
    JSON.stringify(
      train.columns.filter(
        (c) => c !== dataset.target && c !== dataset.id_column,
      ),
    ) !== JSON.stringify(dataset.features)
  )
    throw new Error("Dataset split/schema mismatch");
  return { dataset, train, test };
}
function validateTables(train: Table, test: Table, target: string, id: string) {
  if (
    !train.columns.includes(target) ||
    target === id ||
    test.columns.includes(target) ||
    train.rows.length < 5 ||
    !test.rows.length
  )
    throw new Error("Invalid target or dataset size");
  const trainIds = new Set(rowIds(train, id));
  if (rowIds(test, id).some((x) => trainIds.has(x)))
    throw new Error("Train/test ID overlap");
  if (
    JSON.stringify(train.columns.filter((c) => c !== target)) !==
    JSON.stringify(test.columns)
  )
    throw new Error("Train/test schema mismatch");
  const col = train.columns.indexOf(target);
  for (const row of train.rows) finite(row[col] ?? "");
}
export async function prepareDataset(
  value: unknown,
  destination: string,
): Promise<Dataset> {
  const x = obj(value);
  keys(x, [
    "input_root",
    "train",
    "test",
    "target",
    "id_column",
    "seed",
    "kind",
    "metric",
    "split",
  ]);
  if (x.kind !== "regression" || x.metric !== "rmse")
    throw new Error("Unsupported regression protocol");
  const root = resolve(str(x.input_root, "input root"));
  const train = await tableFile(root, str(x.train, "train")),
    test = await tableFile(root, str(x.test, "test"));
  const target = str(x.target, "target"),
    id = str(x.id_column, "id"),
    seed = integer(x.seed, "seed", 0);
  validateTables(train, test, target, id);
  const ids = rowIds(train, id);
  const ordered = [...ids].sort((a, b) =>
    sha256(Buffer.from(`${seed}:${a}`)).localeCompare(
      sha256(Buffer.from(`${seed}:${b}`)),
    ),
  );
  const count = Math.max(1, Math.floor(ids.length * 0.2));
  const s =
    x.split === undefined
      ? { train: ordered.slice(count), validation: ordered.slice(0, count) }
      : obj(x.split);
  keys(s, ["train", "validation"]);
  const fit = strings(s.train, "train IDs"),
    val = strings(s.validation, "validation IDs");
  if (
    new Set([...fit, ...val]).size !== ids.length ||
    fit.length + val.length !== ids.length ||
    [...fit, ...val].some((v) => !ids.includes(v)) ||
    !fit.length ||
    !val.length
  )
    throw new Error("Invalid split membership");
  // Never overwrite an existing preparation or publish the source directory itself.
  await mkdir(destination, { recursive: false });
  await writeFile(join(destination, "train.csv"), csv(train), {
    flag: "wx",
    mode: 0o444,
  });
  await writeFile(join(destination, "test.csv"), csv(test), {
    flag: "wx",
    mode: 0o444,
  });
  const dataset = validateDataset({
    schema_version: 1,
    kind: "regression",
    metric: "rmse",
    direction: "minimize",
    target,
    id_column: id,
    seed,
    features: train.columns.filter((c) => c !== id && c !== target),
    files: await Promise.all([
      describeFile(destination, "train.csv"),
      describeFile(destination, "test.csv"),
    ]),
    split: { train: fit, validation: val, sha256: splitHash(fit, val) },
  });
  await writeJson(join(destination, "dataset.json"), dataset);
  return dataset;
}
