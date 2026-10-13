import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { dockerCommand } from "../execution/docker";
import { createSession } from "../execution/factory";
import { type SessionConfig, validateConfig } from "../execution/protocol";
import { buildNotebooks, exportNotebooks } from "./notebook";
import { buildScripts } from "./script-journal";
import { verifyScriptExport } from "./scripts";
import {
  type Manifest,
  object,
  RunRecorder,
  readEvents,
  readManifest,
  safeRelativePath,
  sha256,
  writeJson,
} from "./store";

export interface ReplayReport {
  status: "passed" | "failed" | "unsupported";
  source_run_id: string;
  run_id?: string;
  directory?: string;
  reasons: string[];
  failed_cell?: string;
  failed_execution?: string;
}
export async function checkReplayInputs(
  manifest: Manifest,
  originalDirectory: string,
): Promise<SessionConfig> {
  const config = validateConfig(manifest.config);
  if (manifest.seed !== config.seed) throw new Error("Recorded seed mismatch");
  if (
    config.inputs.length !== manifest.inputs.length ||
    new Set(config.inputs).size !== config.inputs.length
  )
    throw new Error("Input list mismatch");
  const root = await realpath(config.input_root);
  const original = await realpath(originalDirectory);
  const rel = relative(original, root);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    throw new Error("Replay input root cannot be the original run directory");
  for (const input of manifest.inputs) {
    safeRelativePath(input.path);
    if (!config.inputs.includes(input.path))
      throw new Error(`Input list mismatch: ${input.path}`);
    let path = root;
    for (const part of input.path.split("/")) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink())
        throw new Error(`Symlink input rejected: ${input.path}`);
    }
    const info = await lstat(path);
    if (!info.isFile())
      throw new Error(`Input is not a regular file: ${input.path}`);
    const content = await readFile(path);
    if (content.length !== input.size_bytes || sha256(content) !== input.sha256)
      throw new Error(`Input checksum mismatch: ${input.path}`);
  }
  return config;
}
export async function replayRun(
  originalDirectory: string,
  runRoot: string,
): Promise<ReplayReport> {
  originalDirectory = resolve(originalDirectory);
  const manifest = await readManifest(originalDirectory);
  const events = await readEvents(originalDirectory);
  const script = manifest.execution?.backend === "fresh-script";
  const scriptView = script ? buildScripts(events) : undefined;
  const notebookView = script
    ? undefined
    : buildNotebooks(events, manifest.run_id);
  const view = scriptView ?? notebookView;
  if (!view) throw Error("Missing replay view");
  if (!manifest.ended_at) view.reasons.push("run_not_finished");
  if (manifest.status !== "completed") view.reasons.push("run_not_completed");
  if (!view.eligible || view.reasons.length)
    return {
      status: "unsupported",
      source_run_id: manifest.run_id,
      reasons: view.reasons,
    };
  const runId = randomUUID();
  // Failed preflight still has a separate run and result; the source manifest is never changed.
  const recorder = await RunRecorder.create({
    runRoot,
    runId,
    config: manifest.config,
    inputs: manifest.inputs,
    image: manifest.image,
    seed: manifest.seed ?? undefined,
    replayOf: manifest.run_id,
  });
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  let failedCell: string | undefined;
  let failure: string | undefined;
  try {
    if (script) await verifyScriptExport(originalDirectory, manifest);
    const originalConfig = await checkReplayInputs(manifest, originalDirectory);
    const images: unknown = JSON.parse(
      await dockerCommand(["image", "inspect", manifest.image.id]),
    );
    if (!Array.isArray(images) || !images.length)
      throw new Error("Original image unavailable");
    const image = object(images[0]);
    if (
      image.Id !== manifest.image.id ||
      `${String(image.Os)}/${String(image.Architecture)}` !==
        manifest.image.platform
    )
      throw new Error("Image identity or platform mismatch");
    const config: SessionConfig = {
      ...originalConfig,
      run_id: runId,
      session_id: undefined,
      image: manifest.image.id,
      platform: manifest.image.platform,
      staging_root: resolve(runRoot, ".staging"),
    };
    recorder.manifest.config = { ...config };
    await recorder.saveManifest();
    session = await createSession(config, recorder);
    // Check the bytes actually mounted by the transport, closing a source-file race at staging.
    if (
      JSON.stringify(recorder.manifest.inputs) !==
      JSON.stringify(manifest.inputs)
    )
      throw new Error("Staged input checksum mismatch");
    const attempts = scriptView
      ? scriptView.scripts.map((s) => ({ id: s.execution_id, source: s.code }))
      : [...(notebookView?.notebooks.values() ?? [])].flatMap((n) => n.cells);
    for (const attempt of attempts) {
      const result = await session.execute(attempt.source);
      if (result.status !== "ok" || !result.persistence_complete) {
        failedCell = attempt.id;
        throw Error(
          `Replay execution ${attempt.id}: ${result.status}; ${result.diagnostic ?? result.error?.evalue ?? "execution failed"}`,
        );
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (session) {
      try {
        await session.close();
        if (session.closeResult?.status !== "ok")
          failure ??= `Session terminal status: ${session.closeResult?.status ?? "unknown"}`;
      } catch (error) {
        failure ??= `Cleanup failed: ${String(error)}`;
      }
    }
  }
  await recorder.finish(failure ? "failed" : "completed");
  try {
    await exportNotebooks(recorder.directory);
  } catch (error) {
    failure ??= `Notebook export failed: ${String(error)}`;
  }
  const status = failure ? "failed" : "passed";
  const finalManifest = await readManifest(recorder.directory);
  finalManifest.replay.result = status;
  if (failure) finalManifest.status = "failed";
  await writeJson(join(recorder.directory, "manifest.json"), finalManifest);
  const report: ReplayReport = {
    status,
    source_run_id: manifest.run_id,
    run_id: runId,
    directory: recorder.directory,
    reasons: failure ? [failure] : [],
    ...(failedCell
      ? script
        ? { failed_execution: failedCell }
        : { failed_cell: failedCell }
      : {}),
  };
  await writeJson(join(recorder.directory, "replay-result.json"), report);
  return report;
}
