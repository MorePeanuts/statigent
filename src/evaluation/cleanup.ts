import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupRun } from "../execution/docker";
import { readManifest, writeJson } from "../records/store";
import { cleanupContainers } from "./agents/docker";
import { id } from "./contracts";
import { inspect } from "./records";
export async function cleanupEvaluation(directory: string) {
  const view = await inspect(directory);
  await cleanupContainers(id(view.manifest.evaluation_id));
  const removed: string[] = [];
  // Native runs have their own IDs. Only discover them inside this batch's owned directory.
  for (const unit of view.plan.units) {
    const parent = join(directory, "native", id(unit.id));
    let entries: string[];
    try {
      entries = await readdir(parent);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    for (const entry of entries) {
      id(entry);
      const manifest = await readManifest(join(parent, entry));
      if (manifest.run_id !== entry)
        throw new Error("Native run ownership mismatch");
      removed.push(...(await cleanupRun(entry)));
    }
  }
  const record = {
    at: new Date().toISOString(),
    evaluation_id: view.manifest.evaluation_id,
    native_removed: removed,
  };
  await writeJson(join(directory, `cleanup-${Date.now()}.json`), record);
  return record;
}
