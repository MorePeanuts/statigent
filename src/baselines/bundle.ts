import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import { describeFile, regular } from "../evaluation/files";
import { command, commandEnvironment } from "../evaluation/process";
import { canonicalJson } from "../modeling/protocol-v2";
import { sha256 } from "../records/store";
import { relativePathSchema } from "./protocol";
import { repositoryRoot } from "./source";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const bundleSchema = z.strictObject({
  schema_version: z.literal(1),
  bundle_id: hash,
  entrypoint: relativePathSchema,
  files: z
    .array(
      z.strictObject({
        path: relativePathSchema,
        sha256: hash,
        bytes: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(100000),
  bytes: z.number().int().nonnegative(),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: z.string().regex(/^linux\/[a-zA-Z0-9_-]+$/),
  frozen_at: z.iso.datetime(),
});
export type FrozenBundle = z.infer<typeof bundleSchema>;

async function inventory(root: string, maxFiles: number, maxBytes: number) {
  const files: { path: string; sha256: string; bytes: number }[] = [];
  let bytes = 0,
    entries = 0;
  const walk = async (prefix: string) => {
    for (const name of (await readdir(join(root, prefix))).sort()) {
      if (++entries > maxFiles * 4) throw new Error("Bundle entry limit");
      const path = relativePathSchema.parse(
        prefix ? `${prefix}/${name}` : name,
      );
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error("Bundle symlink rejected");
      if (info.isDirectory()) await walk(path);
      else {
        if (
          !info.isFile() ||
          files.length >= maxFiles ||
          bytes + info.size > maxBytes
        )
          throw new Error("Bundle file/size limit");
        const file = await describeFile(root, path);
        files.push(file);
        bytes += file.bytes;
      }
    }
  };
  if (
    !(await lstat(root)).isDirectory() ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new Error("Invalid bundle root");
  await walk("");
  return {
    files: files.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    bytes,
  };
}
function identity(
  value: Omit<FrozenBundle, "bundle_id" | "schema_version" | "frozen_at">,
) {
  return sha256(Buffer.from(canonicalJson(value)));
}
export async function verifyBundle(root: string, value: unknown) {
  const bundle = bundleSchema.parse(value);
  const actual = await inventory(
    resolve(root),
    bundle.files.length,
    bundle.bytes,
  );
  const { bundle_id, schema_version: _s, frozen_at: _t, ...content } = bundle;
  if (
    identity(content) !== bundle_id ||
    canonicalJson(actual.files) !== canonicalJson(bundle.files) ||
    actual.bytes !== bundle.bytes ||
    !bundle.files.some((f) => f.path === bundle.entrypoint)
  )
    throw new Error("Frozen model bundle identity mismatch");
  await regular(root, bundle.entrypoint);
  return bundle;
}

/** tar 大对象流式写入有界本次目录；不经过文本缓冲或解包命令。 */
async function archiveContainer(
  container: string,
  bundle: string,
  path: string,
  maxBytes: number,
  maxFiles: number,
  payloadBytes: number,
  signal: AbortSignal,
  timeout: number,
) {
  signal.throwIfAborted();
  const file = await open(path, "wx", 0o600);
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      container,
      "uv",
      "run",
      "--frozen",
      "--offline",
      "--no-sync",
      "--project",
      "/opt/runtime",
      "python",
      "-c",
      await readFile(
        join(repositoryRoot, "python/statigent_baselines/bundle_snapshot.py"),
        "utf8",
      ),
      bundle,
      String(maxFiles),
      String(payloadBytes),
    ],
    {
      env: commandEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let failure: Error | undefined;
  const stop = (message: string) => {
    failure ??= new Error(message);
    proc.kill("SIGKILL");
  };
  const cancel = () => stop("Bundle archive cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop("Bundle archive timeout"), timeout);
  try {
    const collect = async () => {
      let bytes = 0;
      for await (const chunk of chunks(proc.stdout)) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          stop("Bundle archive limit");
          break;
        }
        await file.writeFile(chunk);
      }
    };
    const errors = async () => {
      let text = "";
      for await (const chunk of chunks(proc.stderr)) {
        text += new TextDecoder().decode(chunk);
        if (text.length > 65536) {
          stop("Archive diagnostics limit");
          break;
        }
      }
      return text;
    };
    const [, stderr, code] = await Promise.all([
      collect(),
      errors(),
      proc.exited,
    ]);
    if (failure) throw failure;
    if (code !== 0) throw new Error(`Bundle archive failed: ${stderr}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    proc.kill("SIGKILL");
    await proc.exited;
    await file.close();
  }
}

export async function freezeContainerBundle(options: {
  container: string;
  bundle: string;
  entrypoint: string;
  destination: string;
  image: string;
  platform: string;
  maxFiles: number;
  maxBytes: number;
  signal: AbortSignal;
  timeout_ms: number;
  stop: () => Promise<void>;
}) {
  relativePathSchema.parse(options.bundle);
  relativePathSchema.parse(options.entrypoint);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(options.container))
    throw new Error("Invalid owned container identity");
  const destination = resolve(options.destination);
  await mkdir(destination, { recursive: false });
  const archive = join(destination, `${randomUUID()}.tar`),
    root = join(destination, "files");
  const started = performance.now();
  const remaining = () => {
    options.signal.throwIfAborted();
    const ms = options.timeout_ms - (performance.now() - started);
    if (ms <= 0) throw new Error("Freeze deadline");
    return Math.floor(ms);
  };
  try {
    // 受信采集器先停止其他任务进程，再从容器内部流式读取 tmpfs。
    try {
      await archiveContainer(
        options.container,
        options.bundle,
        archive,
        options.maxBytes + options.maxFiles * 8192 + 1048576,
        options.maxFiles,
        options.maxBytes,
        options.signal,
        remaining(),
      );
    } finally {
      await options.stop();
    }
    await command(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "--project",
        repositoryRoot,
        "python",
        join(repositoryRoot, "python/statigent_baselines/bundle_extract.py"),
        archive,
        root,
        "--max-files",
        String(options.maxFiles),
        "--max-bytes",
        String(options.maxBytes),
      ],
      {
        timeout_ms: remaining(),
        signal: options.signal,
        env: commandEnvironment(),
      },
    );
    const content = {
      ...(await inventory(root, options.maxFiles, options.maxBytes)),
      entrypoint: options.entrypoint,
      image: options.image,
      platform: options.platform,
    };
    const manifest = bundleSchema.parse({
      schema_version: 1,
      bundle_id: identity(content),
      ...content,
      frozen_at: new Date().toISOString(),
    });
    await verifyBundle(root, manifest);
    if (Buffer.byteLength(JSON.stringify(manifest)) > 32 * 1024 ** 2)
      throw new Error("Bundle manifest limit");
    await writeFile(
      join(destination, "bundle.json"),
      JSON.stringify(manifest),
      { flag: "wx", mode: 0o444 },
    );
    await chmod(root, 0o555);
    return { root, manifest };
  } catch (error) {
    await options.stop();
    throw error;
  } finally {
    await rm(archive, { force: true });
  }
}
export async function readBundle(directory: string) {
  const path = await regular(directory, "bundle.json");
  if ((await lstat(path)).size > 32 * 1024 ** 2)
    throw new Error("Bundle manifest limit");
  const manifest = await verifyBundle(
    join(directory, "files"),
    JSON.parse(await readFile(path, "utf8")),
  );
  return { root: join(directory, "files"), manifest };
}

async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}
