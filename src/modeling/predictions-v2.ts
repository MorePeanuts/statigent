import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command, commandEnvironment } from "../evaluation/process";
import { integer, keys, obj, str, strings } from "../models/validation";
import { type DataLimits, parseDataLimits } from "./data-limits";
import { type ProtocolV2, validateProtocolV2 } from "./protocol-v2";
import type { ScoringFileV2 } from "./scoring-v2";

export async function validatePredictionFilesV2(options: {
  root: string;
  protocol: ProtocolV2;
  expected: ScoringFileV2;
  predictions: ScoringFileV2;
  limits: DataLimits;
  signal?: AbortSignal;
  timeout_ms?: number;
  execute?: typeof command;
}) {
  const protocol = validateProtocolV2(options.protocol),
    request_id = randomUUID();
  const root = resolve(options.root, "prediction-validation", request_id);
  await mkdir(root, { recursive: true });
  const request = {
    version: 2,
    request_id,
    protocol,
    expected: options.expected,
    predictions: options.predictions,
    limits: parseDataLimits(options.limits),
  };
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 1024 * 1024)
    throw new Error("Prediction request too large");
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
        "statigent_modeling.predictions_v2",
      ],
      {
        input,
        signal: options.signal,
        timeout_ms: options.timeout_ms ?? 30000,
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
      throw new Error("Prediction response identity mismatch");
    await writeFile(resolve(root, "response.json"), JSON.stringify(raw), {
      flag: "wx",
    });
    if (!raw.ok) throw new Error(str(raw.error, "prediction error"));
    if (raw.error !== undefined)
      throw new Error("Conflicting prediction response");
    const result = obj(raw.result);
    keys(result, ["protocol_sha256", "predictions_sha256", "rows", "targets"]);
    if (
      result.protocol_sha256 !== protocol.protocol_sha256 ||
      result.predictions_sha256 !== options.predictions.sha256 ||
      JSON.stringify(strings(result.targets, "prediction targets")) !==
        JSON.stringify(protocol.targets.map((t) => t.name))
    )
      throw new Error("Prediction contract mismatch");
    return {
      protocol_sha256: protocol.protocol_sha256,
      predictions_sha256: options.predictions.sha256,
      rows: integer(result.rows, "prediction rows"),
      targets: protocol.targets.map((t) => t.name),
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
