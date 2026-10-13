import { expect, test } from "bun:test";
import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent } from "../../src/agent/run";
import { exportNotebooks } from "../../src/records/notebook";
import {
  inspectModelJournal,
  RunRecorder,
  readManifest,
  sha256,
} from "../../src/records/store";
import {
  call,
  fakeRuntime,
  finish,
  profile,
  reply,
  ScriptClient,
  task,
} from "../helpers/agent";
import { collaborationRecorder } from "../helpers/collaboration";

async function hashes(directory: string) {
  const out: Record<string, string> = {};
  for (const path of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }))
    if (path.isFile())
      out[join(path.parentPath, path.name)] = sha256(
        await readFile(join(path.parentPath, path.name)),
      );
  return out;
}
test("legacy v1/v2/v3 runtime, single and dual records export without changing source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "script-legacy-"));
  const legacy = join(root, "v1");
  await cp(resolve("tests/fixtures/legacy-run"), legacy, { recursive: true });
  const runtime = await RunRecorder.create({
    runRoot: root,
    config: {},
    inputs: [],
    image: { id: "fixture", platform: "linux/arm64" },
  });
  await runtime.finish("completed");
  const dual = await collaborationRecorder(root);
  await dual.finish("completed");
  const single = await runAgent({
    task,
    profile,
    runRoot: root,
    client: new ScriptClient((_b, i) =>
      reply([
        i === 0
          ? call("execute_python", { code: "print(1)" })
          : finish("cell-1"),
      ]),
    ),
    createSession: fakeRuntime().createSession,
    export: (d, _, s) => exportNotebooks(d, async () => {}, s),
  });
  for (const [directory, version] of [
    [runtime.directory, 2],
    [single.directory, 2],
    [dual.directory, 3],
  ] as const) {
    const m = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    m.schema_version = version;
    delete m.execution;
    await writeFile(join(directory, "manifest.json"), JSON.stringify(m));
  }
  for (const directory of [
    legacy,
    runtime.directory,
    single.directory,
    dual.directory,
  ]) {
    const before = await hashes(directory);
    const m = await readManifest(directory);
    expect(m.execution).toBeUndefined();
    await inspectModelJournal(directory);
    const exported = await exportNotebooks(directory, async () => {});
    expect(exported.directory).not.toBe(directory);
    expect(await hashes(directory)).toEqual(before);
  }
});
