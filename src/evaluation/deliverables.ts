import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { imageInfo } from "../models/images";
import { imageReferences, resolveImageReference } from "../records/markdown";
import { safeRelativePath } from "../records/store";
import {
  type Deliverable,
  deliveryLimits,
  LIMITS,
  type OutputContract,
  validateDeliverables,
} from "./contracts";

const MAX_DEPTH = 4;
async function hashFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
/** Lists every regular file under `root`, rejecting links, special files, depth and size overruns. */
async function walk(
  root: string,
): Promise<{ path: string; absolute: string }[]> {
  const base = resolve(root);
  const top = await lstat(base);
  if (
    top.isSymbolicLink() ||
    !top.isDirectory() ||
    (await realpath(base)) !== base
  )
    throw new Error("Deliverables root must be a real directory");
  const files: { path: string; absolute: string }[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error("Deliverables nested too deeply");
    for (const entry of await readdir(directory)) {
      const absolute = join(directory, entry);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`Deliverable is a symlink: ${entry}`);
      if (stat.isDirectory()) await visit(absolute, depth + 1);
      else if (stat.isFile()) {
        const path = safeRelativePath(
          relative(base, absolute).split("\\").join("/"),
        );
        files.push({ path, absolute });
        if (files.length > LIMITS.deliverable_files)
          throw new Error("Too many deliverables");
      } else throw new Error(`Deliverable is not a regular file: ${entry}`);
    }
  };
  await visit(base, 0);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/** Hashes the unit's deliverables and makes them read-only. Throws on any violation. */
export async function freezeDeliverables(
  root: string,
  output?: OutputContract,
): Promise<Deliverable[]> {
  const files = await walk(root);
  const result: Deliverable[] = [];
  let total = 0;
  for (const f of files) {
    const { sha256, bytes } = await hashFile(f.absolute);
    if (bytes > deliveryLimits(output).file)
      throw new Error(`Deliverable too large: ${f.path}`);
    total += bytes;
    if (total > deliveryLimits(output).total)
      throw new Error("Deliverables exceed total limit");
    await chmod(f.absolute, 0o444);
    result.push({ path: f.path, bytes, sha256 });
  }
  return result;
}
/**
 * Moves an invalid deliverables directory aside so the unit keeps an empty, scorable directory and the
 * rejected files stay available for audit.
 */
export async function quarantineDeliverables(root: string): Promise<void> {
  await rename(root, `${root}.rejected`);
  await mkdir(root, { mode: 0o700 });
}
/** Re-checks frozen deliverables before scoring: exact file set and hashes. */
export async function verifyDeliverables(
  root: string,
  expected: Deliverable[],
  output?: OutputContract,
): Promise<void> {
  validateDeliverables(expected, output);
  const files = (await walk(root)).map((f) => f.path);
  const listed = expected.map((d) => d.path).sort();
  if (files.length !== listed.length || files.some((p, i) => p !== listed[i]))
    throw new Error("Deliverable set changed after freezing");
  for (const d of expected) {
    const actual = await hashFile(join(resolve(root), d.path));
    if (actual.sha256 !== d.sha256 || actual.bytes !== d.bytes)
      throw new Error(`Deliverable integrity mismatch: ${d.path}`);
  }
}
export interface ReportDeliverable {
  report: string;
  images: string[];
}
/** Validates a report output: the Markdown file and every image it references must be frozen deliverables. */
export async function validateReport(
  output: OutputContract,
  root: string,
  deliverables: Deliverable[],
): Promise<ReportDeliverable> {
  if (output.kind !== "report") throw new Error("Not a report task");
  const report = deliverables.find((d) => d.path === output.report_file);
  if (!report) throw new Error(`Missing report: ${output.report_file}`);
  if (report.bytes > output.max_report_bytes)
    throw new Error("Report too large");
  const bytes = await Bun.file(join(resolve(root), report.path)).bytes();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Report is not UTF-8");
  }
  const images: string[] = [];
  for (const raw of imageReferences(text)) {
    const path = resolveImageReference(output.report_file, raw);
    const d = deliverables.find((x) => x.path === path);
    if (!d) throw new Error(`Report image not delivered: ${raw}`);
    const info = imageInfo(await Bun.file(join(resolve(root), d.path)).bytes());
    if (!info || !(output.image_types as string[]).includes(info.format))
      throw new Error(`Report image type not allowed: ${raw}`);
    if (d.bytes > output.max_image_bytes)
      throw new Error(`Report image too large: ${raw}`);
    if (!images.includes(path)) images.push(path);
  }
  if (images.length > output.max_images)
    throw new Error("Too many report images");
  return { report: text, images };
}
