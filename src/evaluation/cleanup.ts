import { readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { cleanupRun } from "../execution/docker";
import { obj } from "../models/validation";
import { readManifest, writeJson } from "../records/store";
import { cleanupContainers } from "./agents/docker";
import { id } from "./contracts";
import { readJson } from "./records";
export async function cleanupEvaluation(
  directory: string,
  operations = { external: cleanupContainers, native: cleanupRun },
) {
  // Cleanup must remain available when an answer/artifact was damaged after a crash.
  const header = obj(await readJson(directory, "manifest.json"));
  const evaluationId = id(header.evaluation_id);
  if (
    header.schema_version !== 1 ||
    basename(resolve(directory)) !== evaluationId
  )
    throw new Error("Evaluation ownership mismatch");
  await operations.external(evaluationId);
  const removed: string[] = [];
  // Native runs have their own IDs. Only discover them inside this batch's owned directory.
  for (const unit of await readdir(join(directory, "native"), {
    withFileTypes: true,
  })) {
    if (!unit.isDirectory() || unit.isSymbolicLink())
      throw new Error("Invalid native directory");
    const parent = join(resolve(directory), "native", id(unit.name));
    let entries: string[];
    try {
      entries = await readdir(parent);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    for (const entry of entries) {
      // runAgent owns this shared staging directory; it is not a native run ID.
      if (entry === ".staging") continue;
      id(entry);
      if ((await realpath(join(parent, entry))) !== join(parent, entry))
        throw new Error("Symlink native run refused");
      const manifest = await readManifest(join(parent, entry));
      if (
        manifest.run_id !== entry ||
        manifest.config.input_root !==
          join(resolve(directory), "units", unit.name, "input")
      )
        throw new Error("Native run ownership mismatch");
      removed.push(...(await operations.native(entry)));
    }
  }
  const record = {
    at: new Date().toISOString(),
    evaluation_id: evaluationId,
    native_removed: removed,
  };
  await writeJson(join(directory, `cleanup-${Date.now()}.json`), record);
  return record;
}
