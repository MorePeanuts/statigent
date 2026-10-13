import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { selectProfile } from "../models/config";
import { integer, keys, obj, str } from "../models/validation";
import { validateBenchmarkModelingTask } from "./config";
import { loadDatasetV3 } from "./dataset-v3";
import {
  DETERMINISTIC_PROFILE,
  DeterministicModelingClient,
  deterministicPipeline,
} from "./deterministic";
import { loadFrozenModel, predictFrozenModel } from "./frozen-model";
import { runModeling } from "./run";

export async function systemBridge(value: unknown, signal: AbortSignal) {
  const x = obj(value);
  keys(x, [
    "version",
    "request_id",
    "operation",
    "run_root",
    "task",
    "mode",
    "models",
    "frozen_root",
    "features",
    "timeout_ms",
  ]);
  if (
    x.version !== 1 ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(str(x.request_id, "request ID"))
  )
    throw new Error("Invalid system bridge identity");
  const runRoot = resolve(str(x.run_root, "run root"));
  if (x.operation === "fit") {
    keys(x, [
      "version",
      "request_id",
      "operation",
      "run_root",
      "task",
      "mode",
      "models",
    ]);
    if (x.mode !== "deterministic" && x.mode !== "live")
      throw new Error("Explicit execution mode required");
    const task = validateBenchmarkModelingTask(x.task);
    if (task.delivery_mode !== "fit_only")
      throw new Error("System fit must not predict");
    const data = await loadDatasetV3(task.dataset_root);
    if (data.dataset.prediction || data.dataset.evaluator.labels)
      throw new Error("System fit received a test partition");
    if (
      x.mode === "deterministic" &&
      (task.method !== "no_eda" ||
        task.model_profile !== DETERMINISTIC_PROFILE.id ||
        task.eda_profile !== DETERMINISTIC_PROFILE.id)
    )
      throw new Error(
        "Deterministic system verification requires no_eda and the fixed profile",
      );
    const profiles: unknown =
      x.mode === "live"
        ? JSON.parse(
            await readFile(resolve(str(x.models, "models config")), "utf8"),
          )
        : [DETERMINISTIC_PROFILE];
    const profile = selectProfile(profiles, task.model_profile),
      edaProfile = selectProfile(profiles, task.eda_profile);
    const client =
      x.mode === "deterministic"
        ? new DeterministicModelingClient(
            deterministicPipeline(data.dataset.protocol),
          )
        : undefined;
    const result = await runModeling({
      task,
      profile,
      edaProfile,
      client,
      signal,
      runRoot,
    });
    const frozen =
      result.status === "model_frozen"
        ? await loadFrozenModel(result.directory)
        : null;
    return {
      result,
      frozen_id: frozen?.frozen_id ?? null,
      mode: x.mode,
      live_llm_calls: client ? 0 : null,
      controlled_decisions: client?.calls ?? null,
    };
  }
  if (x.operation === "predict") {
    keys(x, [
      "version",
      "request_id",
      "operation",
      "run_root",
      "frozen_root",
      "features",
      "timeout_ms",
    ]);
    const f = obj(x.features);
    keys(f, ["path", "bytes", "sha256"]);
    const hash = str(f.sha256, "features hash");
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid features identity");
    return predictFrozenModel({
      frozenRoot: resolve(str(x.frozen_root, "frozen root")),
      runRoot,
      features: {
        path: resolve(str(f.path, "features path")),
        bytes: integer(f.bytes, "bytes", 0),
        sha256: hash,
      },
      timeout_ms: integer(x.timeout_ms, "prediction timeout"),
      signal,
    });
  }
  throw new Error("Unknown system bridge operation");
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  let requestId: unknown = null;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = Bun.stdin.stream().getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("System bridge request limit");
      chunks.push(chunk);
    }
    const request: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requestId = obj(request).request_id;
    const result = await systemBridge(request, controller.signal);
    const output = JSON.stringify({
      version: 1,
      request_id: requestId,
      ok: true,
      result,
    });
    if (Buffer.byteLength(output) > 1024 * 1024)
      throw new Error("System bridge reply limit");
    process.stdout.write(output);
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        version: 1,
        request_id: requestId,
        ok: false,
        error: String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
}
