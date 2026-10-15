import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TRAJECTORY_LIMIT,
  truncateMiddle,
} from "../evaluation/agents/trajectory";
import type { OutputContract } from "../evaluation/contracts";
import { imageInfo } from "../models/images";
import { imageReferences, resolveImageReference } from "../records/markdown";
import type { BaselineArtifacts } from "./execution";

export async function deliverBaselineReport(
  artifacts: BaselineArtifacts,
  path: string,
  output: Extract<OutputContract, { kind: "report" }>,
  destination: string,
) {
  // 保留原报告相对引用，明确要求交付契约中的文件名。
  if (path !== output.report_file)
    throw new Error("Report path does not match contract");
  const bytes = await artifacts.read(path);
  if (bytes.length > output.max_report_bytes)
    throw new Error("Report size limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const references = [
    ...new Set(
      imageReferences(text).map((ref) => resolveImageReference(path, ref)),
    ),
  ];
  if (references.length > output.max_images)
    throw new Error("Report image count limit");
  const files: { path: string; bytes: Buffer }[] = [{ path, bytes }];
  for (const imagePath of references) {
    const data = await artifacts.read(imagePath),
      info = imageInfo(data);
    if (
      !info ||
      !(output.image_types as string[]).includes(info.format) ||
      data.length > output.max_image_bytes
    )
      throw new Error("Invalid report image format/size");
    files.push({ path: imagePath, bytes: data });
  }
  for (const file of files) {
    await mkdir(dirname(join(destination, file.path)), { recursive: true });
    await writeFile(join(destination, file.path), file.bytes, { flag: "wx" });
  }
  return text;
}
export function baselineTrajectory(
  steps: { code: string; status: string; preview: string; epoch: number }[],
  report: string | null,
) {
  return truncateMiddle(
    [
      "# Analysis trajectory (trajectory-v1)",
      "Mapping: baseline-execution-v1; order includes replay; previews may be truncated.",
      ...steps.flatMap((s, index) => [
        `## Step ${index + 1} (epoch ${s.epoch}, status ${s.status})`,
        "```python",
        s.code,
        "```",
        "```text",
        s.preview,
        "```",
      ]),
      "## Final report",
      report ?? "(no report delivered)",
    ].join("\n\n"),
    TRAJECTORY_LIMIT,
  );
}
