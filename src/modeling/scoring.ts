import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describeFile } from "../evaluation/files";
import { command, commandEnvironment } from "../evaluation/process";
import { keys, obj, str } from "../models/validation";
import { csv, type Table } from "./data";
import { type Protocol, validateScore } from "./protocol";
export class ScoringFailure extends Error {}
export async function scoreTables(o: {
  root: string;
  protocol: Protocol;
  id: string;
  target: string;
  labels: Table;
  predictions: Table;
  signal?: AbortSignal;
  timeout_ms?: number;
  execute?: typeof command;
}) {
  const began = performance.now();
  const request_id = randomUUID(),
    root = resolve(o.root, "scoring", request_id);
  await mkdir(root, { recursive: true });
  const file = async (name: string, t: Table) => {
    await writeFile(join(root, name), csv(t), { flag: "wx", mode: 0o444 });
    return { ...(await describeFile(root, name)), path: join(root, name) };
  };
  const request = {
    version: 1,
    request_id,
    protocol: o.protocol,
    id_column: o.id,
    target: o.target,
    labels: await file("labels.csv", o.labels),
    predictions: await file("predictions.csv", o.predictions),
  };
  await writeFile(join(root, "request.json"), JSON.stringify(request), {
    flag: "wx",
  });
  try {
    const remaining =
      Math.min(30000, o.timeout_ms ?? 30000) - (performance.now() - began);
    if (remaining <= 0) throw new Error("Scoring deadline");
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 1024 ** 2)
      throw new Error("Scoring request too large");
    const env = commandEnvironment();
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    const r = await (o.execute ?? command)(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "python",
        "-m",
        "statigent_modeling.scoring",
      ],
      {
        input,
        env: { ...env, PYTHONPATH: resolve("python") },
        signal: o.signal,
        timeout_ms: Math.max(1, Math.floor(remaining)),
        stdout_limit: 1024 ** 2,
        stderr_limit: 65536,
      },
    );
    const x = obj(JSON.parse(r.stdout));
    keys(x, [
      "version",
      "request_id",
      "protocol_sha256",
      "ok",
      "score",
      "error",
    ]);
    if (
      x.version !== 1 ||
      x.request_id !== request_id ||
      x.protocol_sha256 !== o.protocol.protocol_sha256 ||
      typeof x.ok !== "boolean"
    )
      throw new Error("Scoring response identity mismatch");
    await writeFile(join(root, "response.json"), JSON.stringify(x), {
      flag: "wx",
    });
    if (x.ok) {
      if (x.error !== undefined) throw new Error("Conflicting score result");
      return { score: validateScore(x.score, o.protocol), error: null };
    }
    if (x.score !== undefined) throw new Error("Conflicting score error");
    const e = obj(x.error);
    keys(e, ["kind", "message"]);
    const message = str(e.message, "scoring error");
    if (e.kind === "invalid_predictions")
      return { score: null, error: message };
    throw new Error(message);
  } catch (e) {
    const error = `scoring_failure:${String(e)}`;
    await writeFile(join(root, "failure.json"), JSON.stringify({ error }), {
      flag: "wx",
    });
    throw new ScoringFailure(error);
  }
}
