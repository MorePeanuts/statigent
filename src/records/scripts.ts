import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildScripts } from "./script-journal";
import {
  type Manifest,
  object,
  readEvents,
  readManifest,
  safeRelativePath,
  sha256,
  writeJson,
} from "./store";
export async function exportScripts(
  directory: string,
  finalizingStatus?: string,
): Promise<Manifest["export"]> {
  const manifest = await readManifest(directory);
  if (manifest.execution?.backend !== "fresh-script")
    throw Error("Script export requires fresh-script");
  const view = buildScripts(await readEvents(directory));
  if (!manifest.ended_at && !finalizingStatus)
    view.reasons.push("run_not_finished");
  if ((finalizingStatus ?? manifest.status) !== "completed")
    view.reasons.push("run_not_completed");
  const folder = `scripts/${randomUUID()}`;
  await mkdir(join(directory, folder), { recursive: true });
  const scripts = [];
  for (const [index, entry] of view.scripts.entries()) {
    const path = `${folder}/${String(index + 1).padStart(4, "0")}-${entry.execution_id}.py`;
    await writeFile(join(directory, path), entry.code, {
      flag: "wx",
      mode: 0o600,
    });
    const { code: _code, ...facts } = entry;
    scripts.push({ ...facts, path });
  }
  const path = `${folder}/manifest.json`;
  await writeJson(join(directory, path), {
    version: 1,
    run_id: manifest.run_id,
    execution: manifest.execution,
    seed: manifest.seed,
    image: manifest.image,
    inputs: manifest.inputs,
    scripts,
  });
  manifest.export = {
    status: "exported",
    kind: "scripts",
    notebook_status: "not_applicable",
    paths: [...scripts.map((s) => s.path), path],
  };
  manifest.replay = {
    ...manifest.replay,
    eligible: view.reasons.length === 0,
    reasons: view.reasons,
  };
  await writeJson(join(directory, "manifest.json"), manifest);
  return manifest.export;
}
export async function verifyScriptExport(
  directory: string,
  manifest: Manifest,
) {
  if (
    manifest.export.status !== "exported" ||
    manifest.export.kind !== "scripts"
  )
    throw Error("Script export missing");
  const path = manifest.export.paths.find((p) => p.endsWith("/manifest.json"));
  if (!path) throw Error("Script list missing");
  const readSource = async (path: string) => {
    safeRelativePath(path);
    if (!path.startsWith("scripts/")) throw Error("Script outside export area");
    let cursor = directory;
    for (const part of path.split("/")) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink())
        throw Error("Symlink script export refused");
    }
    if (!(await lstat(cursor)).isFile())
      throw Error("Script must be a regular file");
    return readFile(cursor);
  };
  const list = object(JSON.parse((await readSource(path)).toString("utf8")));
  if (
    list.version !== 1 ||
    list.run_id !== manifest.run_id ||
    JSON.stringify(list.execution) !== JSON.stringify(manifest.execution) ||
    list.seed !== manifest.seed ||
    JSON.stringify(list.image) !== JSON.stringify(manifest.image) ||
    JSON.stringify(list.inputs) !== JSON.stringify(manifest.inputs)
  )
    throw Error("Script export environment mismatch");
  const view = buildScripts(await readEvents(directory));
  if (
    !Array.isArray(list.scripts) ||
    list.scripts.length !== view.scripts.length
  )
    throw Error("Script list mismatch");
  for (const [index, item] of list.scripts.entries()) {
    const script = object(item),
      entry = view.scripts[index];
    if (!entry) throw Error("Missing script");
    if (
      script.execution_id !== entry.execution_id ||
      script.execution_seq !== entry.execution_seq ||
      script.sha256 !== entry.sha256 ||
      script.status !== entry.status
    )
      throw Error("Script export identity mismatch");
    const relative = safeRelativePath(String(script.path));
    if (!manifest.export.paths.includes(relative))
      throw Error("Unlisted script");
    const bytes = await readSource(relative);
    if (sha256(bytes) !== entry.sha256)
      throw Error("Script source checksum mismatch");
  }
  return view;
}
