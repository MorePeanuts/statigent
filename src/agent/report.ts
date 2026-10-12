import { join } from "node:path";
import { imageInfo } from "../models/images";
import { integer, keys, obj, strings } from "../models/validation";
import {
  imageReferences,
  normalizeReference,
  resolveImageReference,
} from "../records/markdown";
import type { ArtifactReference } from "../records/store";

export interface ReportSpec {
  image_types: ("png" | "jpeg")[];
  max_images: number;
  max_image_bytes: number;
  max_report_bytes: number;
}
export function validateReportSpec(value: unknown): ReportSpec {
  const x = obj(value);
  keys(x, ["image_types", "max_images", "max_image_bytes", "max_report_bytes"]);
  const types = strings(x.image_types, "image_types");
  if (
    !types.length ||
    types.some((t) => t !== "png" && t !== "jpeg") ||
    new Set(types).size !== types.length
  )
    throw new Error("Invalid report image types");
  return {
    image_types: types as ReportSpec["image_types"],
    max_images: integer(x.max_images, "max_images", 0),
    max_image_bytes: integer(x.max_image_bytes, "max_image_bytes"),
    max_report_bytes: integer(x.max_report_bytes, "max_report_bytes"),
  };
}
export interface AnalysisReport {
  artifact_id: string;
  source_path: string;
  /** `reference` is the normalized path as written in the report, relative to the report. */
  images: { reference: string; path: string; artifact_id: string }[];
}
/**
 * Checks a report the model points to: it must be a Markdown file saved in this run, and every image it
 * references must resolve to the latest saved PNG/JPEG at that workspace path.
 */
export async function resolveReport(
  directory: string,
  artifacts: readonly ArtifactReference[],
  artifactId: string,
  spec: ReportSpec,
): Promise<AnalysisReport> {
  const report = artifacts.find((a) => a.artifact_id === artifactId);
  if (!report?.complete || !report.source_path)
    throw new Error("report_artifact_id is not a saved file of this run");
  if (!report.source_path.endsWith(".md"))
    throw new Error("Report must be a Markdown (.md) file");
  if (report.size_bytes > spec.max_report_bytes)
    throw new Error("Report exceeds the size limit");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      await Bun.file(join(directory, report.path)).bytes(),
    );
  } catch {
    throw new Error("Report is not UTF-8 text");
  }
  const images: AnalysisReport["images"] = [];
  for (const raw of imageReferences(text)) {
    const path = resolveImageReference(report.source_path, raw);
    // The workspace is re-snapshotted after each cell; the latest saved version is the one delivered.
    const saved = [...artifacts]
      .reverse()
      .find((a) => a.complete && a.source_path === path);
    if (!saved)
      throw new Error(`Report image was not saved in this run: ${raw}`);
    if (saved.size_bytes > spec.max_image_bytes)
      throw new Error(`Report image exceeds the size limit: ${raw}`);
    const info = imageInfo(await Bun.file(join(directory, saved.path)).bytes());
    if (!info || !(spec.image_types as string[]).includes(info.format))
      throw new Error(
        `Report image must be ${spec.image_types.join("/")}: ${raw}`,
      );
    const reference = normalizeReference(raw);
    if (!images.some((i) => i.reference === reference))
      images.push({ reference, path, artifact_id: saved.artifact_id });
  }
  if (images.length > spec.max_images)
    throw new Error(`Report references more than ${spec.max_images} images`);
  return {
    artifact_id: report.artifact_id,
    source_path: report.source_path,
    images,
  };
}
