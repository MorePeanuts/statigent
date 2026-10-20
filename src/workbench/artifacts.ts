import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { imageInfo } from "../models/images";
import {
  type ArtifactReference,
  type Manifest,
  readArtifact,
  readManifest,
  safeRelativePath,
} from "../records/store";
import { HttpError } from "./http";
import { RUN_ID_PATTERN } from "./protocol";

// Read-only access for the browser. Only a run directory directly under the workbench run root,
// only artifacts the manifest registered (with their checksums), and only result files the run
// itself names can be read. Nothing is ever served as HTML or script.

const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIXED_FILES = ["analysis.json", "analysis.md"];

/** Headers for every artifact or file response: never sniffed, never rendered as a document. */
export const CONTENT_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "private, no-cache",
};

export interface ServedContent {
  body: Uint8Array;
  contentType: string;
  /** File name offered when the content is downloaded. */
  filename: string;
  /** True when the browser should download instead of display (opaque binary, notebooks). */
  attachment: boolean;
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The run's record directory, or a 404 when the ID or its location is not acceptable. */
export async function runDirectory(
  runsRoot: string,
  runId: string,
): Promise<string> {
  const notFound = new HttpError("Run not found", 404);
  if (!RUN_ID_PATTERN.test(runId)) throw notFound;
  const directory = join(runsRoot, runId);
  if (!(await realDirectory(directory))) throw notFound;
  const [root, resolved] = await Promise.all([
    realpath(runsRoot),
    realpath(directory),
  ]);
  if (resolved !== join(root, runId) || !resolved.startsWith(root + sep))
    throw notFound;
  return directory;
}

export async function runManifest(
  runsRoot: string,
  runId: string,
): Promise<{ directory: string; manifest: Manifest }> {
  const directory = await runDirectory(runsRoot, runId);
  try {
    return { directory, manifest: await readManifest(directory) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new HttpError("Run record not created yet", 404);
    throw error;
  }
}

function textType(mime: string): string | null {
  if (mime === "application/json") return "application/json; charset=utf-8";
  // text/html, image/svg+xml and similar would execute if rendered; they are plain text here.
  if (
    mime.startsWith("text/") ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  )
    return "text/plain; charset=utf-8";
  return null;
}

function contentFor(
  body: Uint8Array,
  declaredMime: string,
  name: string,
): ServedContent {
  // Images are recognised from their bytes, not from the declared type.
  const image = imageInfo(body);
  if (image)
    return {
      body,
      contentType: `image/${image.format}`,
      filename: name,
      attachment: false,
    };
  const text = textType(declaredMime);
  if (text)
    return { body, contentType: text, filename: name, attachment: false };
  return {
    body,
    contentType: "application/octet-stream",
    filename: name,
    attachment: true,
  };
}

export async function readRunArtifact(
  runsRoot: string,
  runId: string,
  artifactId: string,
): Promise<ServedContent> {
  if (!ARTIFACT_ID.test(artifactId))
    throw new HttpError("Artifact not found", 404);
  const { directory, manifest } = await runManifest(runsRoot, runId);
  const ref = (manifest.artifacts as ArtifactReference[]).find(
    (a) => a.artifact_id === artifactId,
  );
  if (!ref) throw new HttpError("Artifact not found", 404);
  if (!(await realDirectory(join(directory, "artifacts"))))
    throw new HttpError("Artifact area is not a regular directory", 422);
  let body: Buffer;
  try {
    body = await readArtifact(directory, ref);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new HttpError("Artifact file is missing", 404);
    // Boundary, symlink and checksum failures: the stored bytes are not what was recorded.
    throw new HttpError(
      `Artifact failed its integrity check: ${error instanceof Error ? error.message : "unreadable"}`,
      422,
    );
  }
  const name =
    ref.source_path?.split("/").pop() ?? ref.delivery_path ?? artifactId;
  return contentFor(body, ref.mime_type, name);
}

/** Result files the run names itself: analysis.json/md and the paths its export recorded. */
export function resultFilePaths(manifest: Manifest): string[] {
  return [...FIXED_FILES, ...(manifest.export?.paths ?? [])];
}

const FILE_TYPES: Record<string, string> = {
  json: "application/json; charset=utf-8",
  md: "text/plain; charset=utf-8",
  ipynb: "application/x-ipynb+json",
  py: "text/plain; charset=utf-8",
};

export async function readResultFile(
  runsRoot: string,
  runId: string,
  path: string,
): Promise<ServedContent> {
  const { directory, manifest } = await runManifest(runsRoot, runId);
  if (!resultFilePaths(manifest).includes(path))
    throw new HttpError("File not found", 404);
  try {
    safeRelativePath(path);
  } catch {
    throw new HttpError("File not found", 404);
  }
  // Every component must be a real directory or, last, a regular file: no symlinks anywhere.
  let current = directory;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new HttpError("File not found", 404);
      throw error;
    }
    const last = index === parts.length - 1;
    if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory()))
      throw new HttpError("File not found", 404);
  }
  const name = parts.at(-1) ?? path;
  const extension = name.split(".").pop() ?? "";
  return {
    body: await readFile(current),
    contentType: FILE_TYPES[extension] ?? "text/plain; charset=utf-8",
    filename: name,
    attachment: extension === "ipynb" || extension === "py",
  };
}

export function contentResponse(
  content: ServedContent,
  download = false,
): Response {
  const headers: Record<string, string> = {
    ...CONTENT_HEADERS,
    "content-type": content.contentType,
  };
  if (content.attachment || download)
    headers["content-disposition"] =
      `attachment; filename*=UTF-8''${encodeURIComponent(content.filename)}`;
  // Copy into an ArrayBuffer-backed view: Buffer's possibly shared backing store is not a BodyInit.
  return new Response(new Uint8Array(content.body), { headers });
}
