import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./http";
import { workbenchRoot } from "./paths";

export const INPUT_EXTENSIONS = ["csv", "tsv", "xlsx", "json", "parquet"];
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// Temporary uploads live inside the input area so the final link is a same-filesystem operation;
// the leading dot keeps them out of listings and out of valid input names.
const STAGING = ".uploading";

export class InputError extends HttpError {}

export interface InputFile {
  name: string;
  size_bytes: number;
  sha256: string;
  modified_at: string;
}

export function inputRoot(): string {
  return join(workbenchRoot(), "inputs");
}

export function maxUploadBytes(
  environment: Record<string, string | undefined> = process.env,
): number {
  const configured = environment.WORKBENCH_MAX_UPLOAD_BYTES;
  if (configured === undefined) return DEFAULT_MAX_UPLOAD_BYTES;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("WORKBENCH_MAX_UPLOAD_BYTES must be a positive integer");
  return value;
}

/** A single path segment that also passes the agent's own input path rules. */
export function validateInputName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (
    name.length > 128 ||
    name !== name.normalize("NFC") ||
    name.includes("..") ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name) ||
    /[ .]$/.test(name) ||
    !name.includes(".")
  )
    throw new InputError(
      "File name must be one segment of letters, digits, spaces, '.', '_' or '-'",
      400,
    );
  if (!INPUT_EXTENSIONS.includes(extension))
    throw new InputError(
      `Allowed extensions: ${INPUT_EXTENSIONS.join(", ")}`,
      400,
    );
  return name;
}

async function regularFile(path: string) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? info : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Hashing a 100 MiB file on every listing would be wasteful; the cache is keyed by identity,
// size and mtime so a replaced file is always rehashed.
const hashes = new Map<string, string>();

async function fileHash(
  path: string,
  info: { ino: number; size: number; mtimeMs: number },
): Promise<string> {
  const key = `${path}\0${info.ino}\0${info.size}\0${info.mtimeMs}`;
  const cached = hashes.get(key);
  if (cached) return cached;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const digest = hash.digest("hex");
  hashes.set(key, digest);
  return digest;
}

async function describe(root: string, name: string): Promise<InputFile> {
  const path = join(root, name);
  const info = await regularFile(path);
  if (!info) throw new InputError("Input file not found", 404);
  return {
    name,
    size_bytes: info.size,
    sha256: await fileHash(path, info),
    modified_at: info.mtime.toISOString(),
  };
}

export async function listInputs(root = inputRoot()): Promise<InputFile[]> {
  let entries: string[];
  try {
    // Runtime data, not code: keep output tracing from including the whole repository.
    entries = await readdir(/*turbopackIgnore: true*/ root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: InputFile[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    try {
      validateInputName(name);
    } catch {
      continue; // Not placed by the workbench (e.g. copied in by hand with an unusable name).
    }
    if (await regularFile(join(root, name)))
      files.push(await describe(root, name));
  }
  return files;
}

export interface SaveOptions {
  maxBytes: number;
  /** Declared body length; a mismatch means the body was cut short or padded in transit. */
  expectedBytes?: number;
}

export async function saveInput(
  name: string,
  body: AsyncIterable<Uint8Array> | null,
  options: SaveOptions,
  root = inputRoot(),
): Promise<InputFile> {
  validateInputName(name);
  if (!body) throw new InputError("Upload body is empty", 400);
  if (options.expectedBytes !== undefined) {
    if (
      !Number.isSafeInteger(options.expectedBytes) ||
      options.expectedBytes < 0
    )
      throw new InputError("Invalid Content-Length", 400);
    if (options.expectedBytes > options.maxBytes)
      throw new InputError(`File exceeds ${options.maxBytes} bytes`, 413);
  }
  const target = join(root, name);
  // Fail before reading the body when the name is already taken; the final link re-checks.
  if (await exists(target))
    throw new InputError("A file with this name already exists", 409);
  const staging = join(root, STAGING);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const temporary = join(staging, randomUUID());
  let handle: FileHandle | undefined = await open(temporary, "wx", 0o600);
  try {
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > options.maxBytes)
        throw new InputError(`File exceeds ${options.maxBytes} bytes`, 413);
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (size === 0) throw new InputError("Upload body is empty", 400);
    if (options.expectedBytes !== undefined && size !== options.expectedBytes)
      throw new InputError(
        `Received ${size} bytes but Content-Length declared ${options.expectedBytes}`,
        400,
      );
    // link() refuses an existing target, so a concurrent upload of the same name cannot be
    // overwritten between the check above and this point.
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new InputError("A file with this name already exists", 409);
      throw error;
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return describe(root, name);
}

export async function deleteInput(
  name: string,
  root = inputRoot(),
): Promise<void> {
  validateInputName(name);
  const path = join(root, name);
  if (!(await regularFile(path)))
    throw new InputError("Input file not found", 404);
  await unlink(path);
}
