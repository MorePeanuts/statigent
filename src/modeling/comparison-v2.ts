import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command, commandEnvironment } from "../evaluation/process";
import { integer, keys, obj, str, strings } from "../models/validation";
import { type DataLimits, parseDataLimits } from "./data-limits";
import { type ProtocolV2, validateProtocolV2 } from "./protocol-v2";
import type { ScoringFileV2 } from "./scoring-v2";

export const PREDICTION_TOLERANCE = { atol: 1e-8, rtol: 1e-6 } as const;
export async function comparePredictionFilesV2(o: {
  root: string;
  protocol: ProtocolV2;
  expected: ScoringFileV2;
  reference: ScoringFileV2;
  actual: ScoringFileV2;
  limits: DataLimits;
  timeout_ms: number;
  signal?: AbortSignal;
  execute?: typeof command;
}) {
  const request_id = randomUUID(),
    root = resolve(o.root, "comparison", request_id);
  await mkdir(root, { recursive: true });
  const request = {
    version: 2,
    request_id,
    protocol: validateProtocolV2(o.protocol),
    expected: o.expected,
    reference: o.reference,
    actual: o.actual,
    limits: parseDataLimits(o.limits),
    tolerance: PREDICTION_TOLERANCE,
  };
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 1024 * 1024)
    throw new Error("Comparison request too large");
  await writeFile(resolve(root, "request.json"), input, { flag: "wx" });
  try {
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
        "statigent_modeling.comparison_v2",
      ],
      {
        input,
        env: { ...env, PYTHONPATH: resolve("python") },
        timeout_ms: o.timeout_ms,
        signal: o.signal,
        stdout_limit: 1024 * 1024,
        stderr_limit: 65536,
      },
    );
    const raw = obj(JSON.parse(response.stdout));
    keys(raw, ["version", "request_id", "ok", "result", "error"]);
    if (
      raw.version !== 2 ||
      raw.request_id !== request_id ||
      typeof raw.ok !== "boolean"
    )
      throw new Error("Comparison response identity mismatch");
    await writeFile(resolve(root, "response.json"), JSON.stringify(raw), {
      flag: "wx",
    });
    if (!raw.ok) throw new Error(str(raw.error, "comparison error"));
    if (raw.error !== undefined)
      throw new Error("Conflicting comparison result");
    const result = obj(raw.result);
    keys(result, [
      "protocol_sha256",
      "reference_sha256",
      "actual_sha256",
      "rows",
      "matched",
      "differences",
      "tolerance",
    ]);
    const differences = strings(result.differences, "prediction differences");
    const fields = new Set([
      "columns",
      ...o.protocol.targets.flatMap((t) =>
        ["values", "probabilities", "ranked"].map((f) => `${t.name}/${f}`),
      ),
    ]);
    if (
      result.protocol_sha256 !== request.protocol.protocol_sha256 ||
      result.reference_sha256 !== o.reference.sha256 ||
      result.actual_sha256 !== o.actual.sha256 ||
      typeof result.matched !== "boolean" ||
      result.matched !== (differences.length === 0) ||
      differences.some((d) => !fields.has(d)) ||
      new Set(differences).size !== differences.length ||
      JSON.stringify(result.tolerance) !== JSON.stringify(PREDICTION_TOLERANCE)
    )
      throw new Error("Invalid prediction comparison contract");
    return {
      matched: result.matched,
      differences,
      rows: integer(result.rows, "comparison rows"),
      protocol_sha256: request.protocol.protocol_sha256,
      reference_sha256: o.reference.sha256,
      actual_sha256: o.actual.sha256,
      tolerance: PREDICTION_TOLERANCE,
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
