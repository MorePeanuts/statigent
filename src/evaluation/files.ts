import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { safeRelativePath } from "../records/store";
import {
  INPUT_PHASES,
  type InputFile,
  type PhaseRoots,
  type PublicTask,
} from "./contracts";

export async function regular(root: string, path: string): Promise<string> {
  safeRelativePath(path);
  const absolute = resolve(root);
  if (
    (await lstat(absolute)).isSymbolicLink() ||
    !(await lstat(absolute)).isDirectory() ||
    (await realpath(absolute)) !== absolute
  )
    throw new Error("Root must not contain symlinks");
  let cursor = absolute;
  const parts = path.split("/");
  for (const [i, part] of parts.entries()) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (
      stat.isSymbolicLink() ||
      (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
    )
      throw new Error("Expected regular input without symlinks");
  }
  return cursor;
}
export async function describeFile(
  root: string,
  path: string,
): Promise<InputFile> {
  const source = await regular(root, path);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(source)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { path, bytes, sha256: hash.digest("hex") };
}
export async function verifyFiles(
  root: string,
  files: InputFile[],
): Promise<void> {
  for (const expected of files) {
    const actual = await describeFile(root, expected.path);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new Error(`Input integrity mismatch: ${expected.path}`);
  }
}
export type PublicationMethod = "clone" | "copy" | "mixed" | "none";
/**
 * Publishes allowlisted inputs. Copy-on-write clones avoid duplicating multi-GB SQLite files per unit;
 * where the filesystem cannot clone, a plain copy is used. Integrity is verified either way.
 */
export async function publishInputs(
  sourceRoot: string,
  task: PublicTask,
  destination: string,
  options: { clone?: boolean; phase?: (typeof INPUT_PHASES)[number] } = {},
): Promise<PublicationMethod> {
  if (task.phase_inputs && !options.phase)
    throw new Error("Phased tasks require an explicit publication phase");
  const phase = options.phase;
  const files = phase
    ? task.inputs.filter((f) => task.phase_inputs?.[phase].includes(f.path))
    : task.inputs;
  if (options.phase && (!task.phase_inputs || !files.length))
    throw new Error("Missing phase whitelist");
  await verifyFiles(sourceRoot, files);
  await mkdir(destination, { recursive: false, mode: 0o755 });
  const used = new Set<"clone" | "copy">();
  for (const file of files) {
    const source = await regular(sourceRoot, file.path),
      target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    let method: "clone" | "copy" = "copy";
    if (options.clone !== false)
      try {
        await copyFile(
          source,
          target,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
        );
        method = "clone";
      } catch {
        // Unsupported on this filesystem (or across devices); remove any partial target and copy.
        await rm(target, { force: true });
      }
    if (method === "copy")
      await copyFile(source, target, constants.COPYFILE_EXCL);
    used.add(method);
    await chmod(target, 0o444);
  }
  await verifyFiles(destination, files);
  return used.size === 0
    ? "none"
    : used.size === 2
      ? "mixed"
      : ([...used][0] ?? "none");
}

/** 受信适配器得到独立阶段目录；容器只能挂载当前执行阶段的进一步子集。 */
export async function publishTaskInputs(
  sourceRoot: string,
  task: PublicTask,
  destination: string,
) {
  if (!task.phase_inputs)
    return {
      method: await publishInputs(sourceRoot, task, destination),
      phase_roots: undefined,
    };
  await mkdir(destination, { recursive: false, mode: 0o755 });
  const roots: PhaseRoots = {
    search: join(destination, "search"),
    eda: join(destination, "eda"),
    confirmation: join(destination, "confirmation"),
    final_fit: join(destination, "final_fit"),
    prediction: join(destination, "prediction"),
  };
  const methods: Partial<
    Record<(typeof INPUT_PHASES)[number], PublicationMethod>
  > = {};
  for (const phase of INPUT_PHASES)
    methods[phase] = await publishInputs(sourceRoot, task, roots[phase], {
      phase,
    });
  return { method: methods, phase_roots: roots };
}
