import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command, commandEnvironment } from "../evaluation/process";
import { integer, keys, obj, str } from "../models/validation";
import { type ProtocolV2, validateProtocolV2 } from "./protocol-v2";
import { type EvaluationPartition, validateScoreV2 } from "./score-v2";
import { ScoringFailure } from "./scoring";

export type DataLimits = {
  max_file_bytes: number;
  max_rows: number;
  max_columns: number;
  max_field_bytes: number;
  max_memory_bytes: number;
};
export const DEFAULT_DATA_LIMITS: DataLimits = {
  max_file_bytes: 32 * 1024 * 1024,
  max_rows: 1000000,
  max_columns: 4096,
  max_field_bytes: 65536,
  max_memory_bytes: 512 * 1024 * 1024,
};
export function parseDataLimits(value: unknown): DataLimits {
  const raw = obj(value);
  keys(raw, Object.keys(DEFAULT_DATA_LIMITS));
  return {
    max_file_bytes: integer(raw.max_file_bytes, "file limit"),
    max_rows: integer(raw.max_rows, "row limit"),
    max_columns: integer(raw.max_columns, "column limit"),
    max_field_bytes: integer(raw.max_field_bytes, "field limit"),
    max_memory_bytes: integer(raw.max_memory_bytes, "memory limit"),
  };
}
export type ScoringFileV2 = { path: string; bytes: number; sha256: string };
export async function scoreFilesV2(o: {
  root: string;
  protocol: ProtocolV2;
  evaluation_id: string;
  partition: EvaluationPartition;
  labels: ScoringFileV2;
  predictions: ScoringFileV2;
  limits: DataLimits;
  signal?: AbortSignal;
  timeout_ms?: number;
  execute?: typeof command;
}) {
  const protocol = validateProtocolV2(o.protocol),
    limits = parseDataLimits(o.limits);
  const requestId = randomUUID(),
    root = resolve(o.root, "scoring", requestId);
  await mkdir(root, { recursive: true });
  const request = {
    version: 2,
    request_id: requestId,
    protocol,
    evaluation_id: o.evaluation_id,
    partition: o.partition,
    labels: o.labels,
    predictions: o.predictions,
    limits,
  };
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 1024 * 1024)
    throw new Error("Scoring request too large");
  await writeFile(resolve(root, "request.json"), input, { flag: "wx" });
  try {
    const env = commandEnvironment();
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    const result = await (o.execute ?? command)(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-m",
        "statigent_modeling.scoring",
      ],
      {
        input,
        env: { ...env, PYTHONPATH: resolve("python") },
        signal: o.signal,
        timeout_ms: o.timeout_ms ?? 30000,
        stdout_limit: 1024 * 1024,
        stderr_limit: 65536,
      },
    );
    const raw = obj(JSON.parse(result.stdout));
    keys(raw, [
      "version",
      "request_id",
      "protocol_sha256",
      "ok",
      "score",
      "error",
    ]);
    if (
      raw.version !== 2 ||
      raw.request_id !== requestId ||
      raw.protocol_sha256 !== protocol.protocol_sha256 ||
      typeof raw.ok !== "boolean"
    )
      throw new Error("Scoring response identity mismatch");
    await writeFile(resolve(root, "response.json"), JSON.stringify(raw), {
      flag: "wx",
    });
    if (raw.ok) {
      if (raw.error !== undefined) throw new Error("Conflicting score result");
      return {
        score: validateScoreV2(raw.score, protocol, {
          evaluation_id: o.evaluation_id,
          partition: o.partition,
        }),
        error: null,
      };
    }
    if (raw.score !== undefined) throw new Error("Conflicting score error");
    const error = obj(raw.error);
    keys(error, ["kind", "message", "diagnostics"]);
    const message = str(error.message, "scoring error");
    if (error.kind === "invalid_predictions")
      return { score: null, error: message };
    throw new Error(message);
  } catch (error) {
    await writeFile(
      resolve(root, "failure.json"),
      JSON.stringify({ error: String(error) }),
      { flag: "wx" },
    );
    throw new ScoringFailure(`scoring_failure:${String(error)}`);
  }
}
