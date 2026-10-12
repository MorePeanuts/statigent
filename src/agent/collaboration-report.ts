import { imageInfo } from "../models/images";
import { imageReferences, normalizeReference } from "../records/markdown";
import {
  type ArtifactReference,
  readArtifact,
  safeRelativePath,
} from "../records/store";
import type { AnalysisReport, ReportSpec } from "./report";

export interface ReturnedImage {
  artifact_id: string;
  reference: string;
  mime_type: string;
  visually_observed: false;
}
export async function returnedImages(
  directory: string,
  artifacts: readonly ArtifactReference[],
  refs: readonly string[],
): Promise<ReturnedImage[]> {
  const images: ReturnedImage[] = [];
  for (const id of new Set(refs)) {
    const ref = artifacts.find((a) => a.artifact_id === id && a.complete);
    if (!ref || !["image/png", "image/jpeg"].includes(ref.mime_type)) continue;
    const info = imageInfo(await readArtifact(directory, ref));
    if (
      !info ||
      (info.format !== "png" && info.format !== "jpeg") ||
      !/^[A-Za-z0-9_-]+$/.test(id)
    )
      continue;
    images.push({
      artifact_id: id,
      reference: safeRelativePath(
        `images/${id}.${info.format === "png" ? "png" : "jpg"}`,
      ),
      mime_type: ref.mime_type,
      visually_observed: false,
    });
  }
  return images;
}
export async function validatePlannerReport(
  markdown: string,
  directory: string,
  artifacts: readonly ArtifactReference[],
  visible: ReadonlyMap<string, ReturnedImage>,
  spec: ReportSpec,
): Promise<AnalysisReport["images"]> {
  if (Buffer.byteLength(markdown) > spec.max_report_bytes)
    throw new Error("Report exceeds the size limit");
  const images: AnalysisReport["images"] = [];
  for (const raw of imageReferences(markdown)) {
    const path = normalizeReference(raw);
    const image = visible.get(path);
    if (!image) throw new Error("Report image was not returned to planner");
    const ref = artifacts.find(
      (a) => a.artifact_id === image.artifact_id && a.complete,
    );
    if (!ref || ref.size_bytes > spec.max_image_bytes)
      throw new Error("Report image missing or exceeds size limit");
    const info = imageInfo(await readArtifact(directory, ref));
    if (
      !info ||
      (info.format !== "png" && info.format !== "jpeg") ||
      !spec.image_types.includes(info.format)
    )
      throw new Error("Report image format not allowed");
    if (!images.some((i) => i.reference === path))
      images.push({ artifact_id: ref.artifact_id, reference: path, path });
  }
  if (images.length > spec.max_images)
    throw new Error("Report has too many images");
  return images;
}
