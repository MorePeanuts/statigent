import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import datawiseSource from "../../environments/baselines/datawiseagent/source.json";
import { verifyFiles } from "../evaluation/files";
import { safeRelativePath, sha256 } from "../records/store";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const datawiseRoot = join(
  repositoryRoot,
  ".tools/baselines/datawiseagent",
);
const sourceSchema = z.strictObject({
  schema_version: z.literal(1),
  repository: z.literal("https://github.com/zimingyou01/DatawiseAgent"),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z
    .array(
      z.strictObject({
        path: z.string().refine((p) => {
          try {
            return safeRelativePath(p) === p;
          } catch {
            return false;
          }
        }),
        git_blob: z.string().regex(/^[a-f0-9]{40}$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(2 * 1024 ** 2),
      }),
    )
    .min(1),
});
export const sourceManifest = sourceSchema.parse(datawiseSource);

async function inventory(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await inventory(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Non-regular upstream source: ${path}`);
  }
  return files.sort();
}

/** 预检只读取已准备的源码，不安装，也不容许额外 importable 文件混入。 */
export async function verifyDatawiseSource(root = datawiseRoot): Promise<void> {
  const expected = sourceManifest.files.map((f) => f.path).sort();
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(expected))
    throw new Error(
      "DatawiseAgent source inventory differs; run explicit prepare in a clean source directory",
    );
  await verifyFiles(root, sourceManifest.files);
}

/** 仅显式准备入口调用。地址来自受信清单，任务和模型不能覆盖。 */
export async function prepareDatawiseSource(): Promise<void> {
  await mkdir(datawiseRoot, { recursive: true });
  for (const file of sourceManifest.files) {
    const target = join(datawiseRoot, file.path);
    let exists = false;
    try {
      await lstat(target);
      exists = true;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    if (exists) {
      await verifyFiles(datawiseRoot, [file]);
      continue;
    }
    const response = await fetch(
      `https://raw.githubusercontent.com/zimingyou01/DatawiseAgent/${sourceManifest.commit}/${file.path}`,
      {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      },
    );
    if (!response.ok || !response.body)
      throw new Error(
        `Source download failed: ${file.path} (${response.status})`,
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > file.bytes)
          throw new Error(`Source size exceeded: ${file.path}`);
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    const gitHash = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (
      size !== file.bytes ||
      sha256(bytes) !== file.sha256 ||
      gitHash !== file.git_blob
    )
      throw new Error(`Source integrity mismatch: ${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    // 再验证父目录，避免写入穿过已有符号链接。
    let current = datawiseRoot;
    for (const part of file.path.split("/").slice(0, -1)) {
      current = join(current, part);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unsafe source directory");
    }
    if ((await lstat(datawiseRoot)).isSymbolicLink())
      throw new Error("Unsafe source root");
    await writeFile(target, bytes, { flag: "wx", mode: 0o444 });
  }
  await verifyDatawiseSource();
}

export async function environmentIdentity(
  method: "autogen" | "datawiseagent" | "autogluon",
) {
  const root = resolve(repositoryRoot, "environments/baselines", method);
  const lock = await readFile(join(root, "uv.lock"));
  const project = await readFile(join(root, "pyproject.toml"));
  if (!(await lstat(join(root, ".venv/pyvenv.cfg"))).isFile())
    throw new Error(
      `Missing ${method} environment; see environments/baselines/README.md`,
    );
  return { root, lock_sha256: sha256(lock), project_sha256: sha256(project) };
}
