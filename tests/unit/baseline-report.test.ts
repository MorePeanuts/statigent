import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaselineArtifacts } from "../../src/baselines/execution";
import {
  baselineTrajectory,
  deliverBaselineReport,
} from "../../src/baselines/report";
import { validateTask } from "../../src/evaluation/contracts";

test("report delivery requires collected local files and rejects escaping or oversized references", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "baseline-report-")),
  );
  try {
    const artifacts = new BaselineArtifacts(join(root, "artifacts"), 1048576);
    const capture = async (path: string, data: Buffer) =>
      artifacts.capture({
        type: "artifact",
        protocol_version: 1,
        request_id: "capture",
        session_id: "report",
        kernel_epoch: 0,
        path,
        data_base64: data.toString("base64"),
        mime_type: path.endsWith("png") ? "image/png" : "text/markdown",
      });
    const output = validateTask({
      schema_version: 2,
      id: "report",
      version: "1",
      goal: "report",
      inputs: [],
      constraints: [],
      output: {
        kind: "report",
        report_file: "report.md",
        instructions: "report",
        image_types: ["png"],
        max_images: 2,
        max_report_bytes: 10000,
        max_image_bytes: 10000,
      },
    }).output;
    if (output.kind !== "report") throw new Error("fixture");
    await expect(
      deliverBaselineReport(
        artifacts,
        "report.md",
        output,
        join(root, "missing"),
      ),
    ).rejects.toThrow("not collected");
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    await capture("plot.png", png);
    await capture(
      "report.md",
      Buffer.from("42\n![plot](plot.png)\n![again](plot.png)"),
    );
    await deliverBaselineReport(
      artifacts,
      "report.md",
      output,
      join(root, "success"),
    );
    expect(await readFile(join(root, "success/report.md"), "utf8")).toContain(
      "42",
    );
    expect(await readFile(join(root, "success/plot.png"))).toEqual(png);
    for (const reference of [
      "../private.png",
      "https://example.com/leak.png",
      "missing.png",
    ]) {
      await capture("report.md", Buffer.from(`![bad](${reference})`));
      await expect(
        deliverBaselineReport(
          artifacts,
          "report.md",
          output,
          join(root, "bad"),
        ),
      ).rejects.toThrow();
    }
    await capture("report.md", Buffer.from("x".repeat(10001)));
    await expect(
      deliverBaselineReport(
        artifacts,
        "report.md",
        output,
        join(root, "large"),
      ),
    ).rejects.toThrow("size");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("trajectory preserves execution/replay order and marks bounded truncation", () => {
  const text = baselineTrajectory(
    [
      { code: "first", status: "error", preview: "failure", epoch: 0 },
      { code: "replay", status: "ok", preview: "42", epoch: 1 },
    ],
    "delivered",
  );
  expect(text.indexOf("first")).toBeLessThan(text.indexOf("replay\n"));
  expect(text).toContain("epoch 1");
  const huge = baselineTrajectory(
    [{ code: "x".repeat(2000000), status: "ok", preview: "done", epoch: 0 }],
    null,
  );
  expect(huge.length).toBeLessThan(2000000);
  expect(huge).toContain("truncated");
});
