import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { safeRelativePath } from "../records/store";
import type { InputFile, PublicTask } from "./contracts";

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
  options: { clone?: boolean } = {},
): Promise<PublicationMethod> {
  await verifyFiles(sourceRoot, task.inputs);
  await mkdir(destination, { recursive: false, mode: 0o755 });
  const used = new Set<"clone" | "copy">();
  for (const file of task.inputs) {
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
  await verifyFiles(destination, task.inputs);
  return used.size === 0
    ? "none"
    : used.size === 2
      ? "mixed"
      : ([...used][0] ?? "none");
}
