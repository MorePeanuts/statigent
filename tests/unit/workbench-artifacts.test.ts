import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeJson } from "../../src/records/store";
import {
  contentResponse,
  readResultFile,
  readRunArtifact,
  runDirectory,
} from "../../src/workbench/artifacts";
import { HttpError } from "../../src/workbench/http";
import { agentRun } from "../helpers/workbench";

// 1x1 PNG header: signature + IHDR chunk header and dimensions, enough for content detection.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
]);

async function completed() {
  const root = await mkdtemp(join(tmpdir(), "workbench-artifacts-"));
  const runsRoot = join(root, "runs");
  await agentRun(runsRoot, "run1");
  return { root, runsRoot, directory: join(runsRoot, "run1") };
}

/** Registers extra bytes as a run artifact, as the recorder would. */
async function addArtifact(
  directory: string,
  body: Buffer,
  mime: string,
  sourcePath?: string,
) {
  const id = randomUUID();
  await writeFile(join(directory, "artifacts", id), body);
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  manifest.artifacts.push({
    artifact_id: id,
    path: `artifacts/${id}`,
    mime_type: mime,
    size_bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    complete: true,
    ...(sourcePath ? { source_path: sourcePath } : {}),
  });
  await writeJson(join(directory, "manifest.json"), manifest);
  return id;
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return 200;
}

test("registered model content is served as JSON with locked-down headers", async () => {
  const { runsRoot, directory } = await completed();
  const manifest = await readManifest(directory);
  const json = manifest.artifacts.find(
    (a) => a.mime_type === "application/json",
  );
  if (!json) throw new Error("expected a JSON artifact");
  const content = await readRunArtifact(runsRoot, "run1", json.artifact_id);
  expect(content.contentType).toBe("application/json; charset=utf-8");
  const response = contentResponse(content);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(JSON.parse(await response.text())).toBeDefined();
});

test("types come from content for images and never render as HTML or SVG", async () => {
  const { runsRoot, directory } = await completed();
  const png = await addArtifact(
    directory,
    PNG,
    "application/octet-stream",
    "chart.png",
  );
  expect((await readRunArtifact(runsRoot, "run1", png)).contentType).toBe(
    "image/png",
  );
  const html = await addArtifact(
    directory,
    Buffer.from("<script>alert(1)</script>"),
    "text/html",
    "page.html",
  );
  expect((await readRunArtifact(runsRoot, "run1", html)).contentType).toBe(
    "text/plain; charset=utf-8",
  );
  const svg = await addArtifact(
    directory,
    Buffer.from("<svg onload='alert(1)'/>"),
    "image/svg+xml",
    "chart.svg",
  );
  expect((await readRunArtifact(runsRoot, "run1", svg)).contentType).toBe(
    "text/plain; charset=utf-8",
  );
  const pickle = await addArtifact(
    directory,
    Buffer.from([0x80, 0x04, 0x95]),
    "application/octet-stream",
    "tables/p1.pkl",
  );
  const binary = await readRunArtifact(runsRoot, "run1", pickle);
  expect(binary).toMatchObject({
    contentType: "application/octet-stream",
    filename: "p1.pkl",
    attachment: true,
  });
  expect(contentResponse(binary).headers.get("content-disposition")).toBe(
    "attachment; filename*=UTF-8''p1.pkl",
  );
});

test("only registered, intact artifacts of well-formed runs are readable", async () => {
  const { root, runsRoot, directory } = await completed();
  const png = await addArtifact(directory, PNG, "image/png");
  // Unregistered or malformed artifact IDs.
  expect(await status(readRunArtifact(runsRoot, "run1", randomUUID()))).toBe(
    404,
  );
  expect(
    await status(readRunArtifact(runsRoot, "run1", "../manifest.json")),
  ).toBe(404);
  // Run IDs that are not plain directory names under the run root.
  for (const runId of ["..", "../run1", "run1/", "missing"])
    expect(await status(readRunArtifact(runsRoot, runId, png))).toBe(404);
  // A run directory that is a symlink to somewhere else.
  await symlink(directory, join(runsRoot, "linked"));
  expect(await status(runDirectory(runsRoot, "linked"))).toBe(404);
  // Bytes changed after recording.
  await writeFile(join(directory, "artifacts", png), Buffer.concat([PNG, PNG]));
  expect(await status(readRunArtifact(runsRoot, "run1", png))).toBe(422);
  // An artifact area replaced by a symlink.
  const elsewhere = join(root, "elsewhere");
  await rename(join(directory, "artifacts"), elsewhere);
  await symlink(elsewhere, join(directory, "artifacts"));
  const json = (await readManifest(directory)).artifacts[0];
  expect(
    await status(readRunArtifact(runsRoot, "run1", String(json?.artifact_id))),
  ).toBe(422);
});

test("result files are limited to analysis outputs and recorded exports", async () => {
  const { runsRoot, directory } = await completed();
  const manifest = await readManifest(directory);
  const notebook = manifest.export.paths[0];
  if (!notebook) throw new Error("expected an exported notebook");
  expect(
    (await readResultFile(runsRoot, "run1", "analysis.json")).contentType,
  ).toBe("application/json; charset=utf-8");
  expect(
    new TextDecoder().decode(
      (await readResultFile(runsRoot, "run1", "analysis.md")).body,
    ),
  ).toContain("run1");
  const exported = await readResultFile(runsRoot, "run1", notebook);
  expect(exported).toMatchObject({
    contentType: "application/x-ipynb+json",
    filename: notebook.split("/").pop(),
    attachment: true,
  });
  for (const path of [
    "manifest.json",
    "events.jsonl",
    "../run1/analysis.json",
    "notebooks",
  ])
    expect(await status(readResultFile(runsRoot, "run1", path))).toBe(404);
});

test("a recorded export path that became a symlink is refused", async () => {
  const { root, runsRoot, directory } = await completed();
  const notebook = (await readManifest(directory)).export.paths[0] ?? "";
  const outside = join(root, "outside.ipynb");
  await writeFile(outside, "{}");
  await mkdir(join(root, "spare"));
  await rename(
    join(directory, notebook),
    join(root, "spare", "original.ipynb"),
  );
  await symlink(outside, join(directory, notebook));
  expect(await status(readResultFile(runsRoot, "run1", notebook))).toBe(404);
});

test("an explicit download keeps the real file name", async () => {
  const { runsRoot } = await completed();
  const response = contentResponse(
    await readResultFile(runsRoot, "run1", "analysis.json"),
    true,
  );
  expect(response.headers.get("content-disposition")).toBe(
    "attachment; filename*=UTF-8''analysis.json",
  );
  expect(
    contentResponse(
      await readResultFile(runsRoot, "run1", "analysis.json"),
    ).headers.get("content-disposition"),
  ).toBeNull();
});
