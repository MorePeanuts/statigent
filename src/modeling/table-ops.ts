import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeFile } from "../evaluation/files";
import { command, commandEnvironment } from "../evaluation/process";
import { integer, keys, obj, str } from "../models/validation";
import { sha256 } from "../records/store";
import { type DataLimits, parseDataLimits } from "./data-limits";
import type { ScoringFileV2 } from "./scoring-v2";

export async function selectFileV2(options: {
  root: string;
  source: ScoringFileV2;
  columns: string[];
  members: string[] | null;
  limits: DataLimits;
  signal?: AbortSignal;
  timeout_ms: number;
  execute?: typeof command;
}) {
  const began = performance.now(),
    request_id = randomUUID(),
    limits = parseDataLimits(options.limits);
  const root = resolve(options.root, "selections", request_id);
  await mkdir(root, { recursive: true });
  const selection = JSON.stringify({
    columns: options.columns,
    members: options.members,
  });
  if (
    Buffer.byteLength(selection) >
    Math.min(limits.max_file_bytes, limits.max_memory_bytes / 8)
  )
    throw new Error("Selection metadata limit exceeded");
  await writeFile(resolve(root, "selection.json"), selection, {
    flag: "wx",
    mode: 0o444,
  });
  const ref = await describeFile(root, "selection.json"),
    output = resolve(root, "data.csv");
  const request = {
    version: 2,
    request_id,
    source: options.source,
    output,
    selection: { ...ref, path: resolve(root, ref.path) },
    limits,
  };
  const input = JSON.stringify(request);
  await writeFile(resolve(root, "request.json"), input, { flag: "wx" });
  try {
    const env = commandEnvironment();
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    const response = await (options.execute ?? command)(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-m",
        "statigent_modeling.table_ops",
      ],
      {
        input,
        signal: options.signal,
        timeout_ms: Math.max(
          1,
          Math.floor(options.timeout_ms - (performance.now() - began)),
        ),
        stdout_limit: 1024 * 1024,
        stderr_limit: 65536,
        env: { ...env, PYTHONPATH: resolve("python") },
      },
    );
    const raw = obj(JSON.parse(response.stdout));
    keys(raw, ["version", "request_id", "ok", "result", "error"]);
    if (
      raw.version !== 2 ||
      raw.request_id !== request_id ||
      typeof raw.ok !== "boolean"
    )
      throw new Error("Selection response identity mismatch");
    await writeFile(resolve(root, "response.json"), JSON.stringify(raw), {
      flag: "wx",
    });
    if (!raw.ok) throw new Error(str(raw.error, "selection error"));
    if (raw.error !== undefined)
      throw new Error("Conflicting selection response");
    const result = obj(raw.result);
    keys(result, ["path", "bytes", "sha256", "rows", "members_sha256"]);
    const actual = await describeFile(root, "data.csv");
    if (
      result.path !== output ||
      actual.bytes !== result.bytes ||
      actual.sha256 !== result.sha256 ||
      actual.bytes > limits.max_file_bytes
    )
      throw new Error("Selection output identity mismatch");
    const membersHash = str(result.members_sha256, "members SHA256");
    if (
      !/^[a-f0-9]{64}$/.test(membersHash) ||
      (options.members !== null &&
        membersHash !== sha256(Buffer.from(JSON.stringify(options.members))))
    )
      throw new Error("Selection member order mismatch");
    const rows = integer(result.rows, "selection rows");
    if (
      rows > limits.max_rows ||
      (options.members !== null && rows !== options.members.length)
    )
      throw new Error("Selection row count mismatch");
    await chmod(output, 0o444);
    return {
      file: { ...actual, path: output },
      rows,
      members_sha256: membersHash,
      elapsed_ms: performance.now() - began,
    };
  } catch (error) {
    await writeFile(
      resolve(root, "failure.json"),
      JSON.stringify({ error: String(error) }),
      { flag: "wx" },
    );
    throw error;
  }
}
