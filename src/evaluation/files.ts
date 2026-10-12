import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath } from "node:fs/promises";
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
export async function publishInputs(
  sourceRoot: string,
  task: PublicTask,
  destination: string,
): Promise<void> {
  await verifyFiles(sourceRoot, task.inputs);
  await mkdir(destination, { recursive: false, mode: 0o755 });
  for (const file of task.inputs) {
    const source = await regular(sourceRoot, file.path),
      target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o444);
  }
  await verifyFiles(destination, task.inputs);
}
