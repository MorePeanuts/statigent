import { safeRelativePath } from "./store";

// Same pattern as the DAComp upstream judge (`llm_judge.py`), so agent and scorer see the same images.
const IMAGE_REFERENCE = /!\[[^\]]*\]\(([^)]+)\)/g;
/** Image targets referenced by a Markdown report, in order, without duplicates. */
export function imageReferences(markdown: string): string[] {
  const seen: string[] = [];
  for (const match of markdown.matchAll(IMAGE_REFERENCE)) {
    const raw = (match[1] ?? "").trim();
    if (!seen.includes(raw)) seen.push(raw);
  }
  return seen;
}
/**
 * Resolves an image reference relative to the report's directory. Only plain relative paths are
 * allowed: no URL scheme, absolute path or `..`; `./` segments are dropped.
 */
export function resolveImageReference(reportPath: string, raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/"))
    throw new Error(`Report image must be a relative path: ${raw}`);
  return safeRelativePath(
    [...reportPath.split("/").slice(0, -1), ...raw.split("/")]
      .filter((part) => part !== ".")
      .join("/"),
  );
}
/** Strips `./` segments so a reference can be reused unchanged in another directory. */
export function normalizeReference(raw: string): string {
  return resolveImageReference("report.md", raw);
}
