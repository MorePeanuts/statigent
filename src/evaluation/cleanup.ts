import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { cleanupRun } from "../execution/docker";
import { obj } from "../models/validation";
import { readManifest, writeJson } from "../records/store";
import { cleanupContainers } from "./agents/docker";
import { id } from "./contracts";
import { readJson } from "./records";

async function directories(root: string): Promise<string[]> {
  try {
    if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
      throw new Error("Invalid owned directory");
    const entries = await readdir(root, { withFileTypes: true });
    return entries.map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Invalid native directory");
      return entry.name === ".staging" ? entry.name : id(entry.name);
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

async function modelingChildren(
  root: string,
  inputRoot: string,
  unitRoot: string,
  clean: typeof cleanupRun,
) {
  const header = obj(await readJson(root, "modeling.json"));
  const config = obj(obj(header.config).task),
    dataset = config.dataset_root;
  if (
    header.schema_version !== 5 ||
    header.kind !== "modeling" ||
    header.run_id !== basename(root) ||
    typeof dataset !== "string" ||
    !(
      dataset.startsWith(`${join(inputRoot, "search")}${sep}`) ||
      dataset.startsWith(`${join(unitRoot, "seed-preparations")}${sep}`)
    )
  )
    throw new Error("Modeling parent ownership mismatch");
  const removed: string[] = [];
  const stages = async (parent: string) => {
    for (const entry of await directories(join(parent, "stages"))) {
      if (entry === ".staging") continue;
      const manifest = await readManifest(join(parent, "stages", entry));
      if (
        manifest.run_id !== entry ||
        manifest.config.input_root !== join(parent, "inputs", entry)
      )
        throw new Error("Modeling stage ownership mismatch");
      removed.push(...(await clean(entry)));
    }
  };
  await stages(root);
  for (const entry of await directories(join(root, "eda"))) {
    if (entry === ".staging") continue;
    const manifest = await readManifest(join(root, "eda", entry));
    if (
      manifest.run_id !== entry ||
      typeof manifest.config.input_root !== "string" ||
      !manifest.config.input_root.startsWith(`${root}${sep}`) ||
      !basename(manifest.config.input_root).endsWith("-input")
    )
      throw new Error("Modeling EDA ownership mismatch");
    removed.push(...(await clean(entry)));
  }
  for (const entry of await directories(join(root, "predictions")))
    await stages(join(root, "predictions", entry));
  return removed;
}
export async function cleanupEvaluation(
  directory: string,
  operations = { external: cleanupContainers, native: cleanupRun },
) {
  // Cleanup must remain available when an answer/artifact was damaged after a crash.
  const header = obj(await readJson(directory, "manifest.json"));
  const evaluationId = id(header.evaluation_id);
  if (
    ![1, 2, 3].some((version) => version === header.schema_version) ||
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
      if ([".staging", "preparations", "seed-preparations"].includes(entry))
        continue;
      id(entry);
      if ((await realpath(join(parent, entry))) !== join(parent, entry))
        throw new Error("Symlink native run refused");
      if (await Bun.file(join(parent, entry, "modeling.json")).exists()) {
        removed.push(
          ...(await modelingChildren(
            join(parent, entry),
            join(resolve(directory), "units", unit.name, "input"),
            parent,
            operations.native,
          )),
        );
        continue;
      }
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
