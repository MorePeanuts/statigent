import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type BridgeMessage,
  type HostRequest,
  ProtocolError,
  parseBridgeMessage,
  type SessionConfig,
} from "./protocol";

export interface TransportMetadata {
  image_id: string;
  image_digest: string[];
  container_platform: string;
  docker_version: string;
  inputs: { path: string; sha256: string; size_bytes: number }[];
  dependencies?: Record<string, string>;
  container_name: string;
}
export interface SessionTransport {
  start(
    config: SessionConfig,
    sessionId: string,
    onMessage: (message: BridgeMessage) => Promise<void>,
    onFailure: (error: Error) => void,
  ): Promise<TransportMetadata>;
  send(message: HostRequest): Promise<void>;
  stop(): Promise<void>;
  readonly containerName: string;
}
export async function dockerCommand(
  args: string[],
  timeoutMs = 10000,
): Promise<string> {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0)
      throw new Error(`docker ${args[0]} failed (${code}): ${stderr.trim()}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}
export function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((p) => p === ".." || p === "." || p === "")
  );
}
export async function stageInputs(config: SessionConfig, sessionId: string) {
  const inputRoot = await realpath(config.input_root);
  await mkdir(config.staging_root, { recursive: true });
  const staging = await mkdtemp(
    join(await realpath(config.staging_root), `${sessionId}-`),
  );
  try {
    await chmod(staging, 0o755);
    const inputs: TransportMetadata["inputs"] = [];
    for (const path of config.inputs) {
      if (!safeRelativePath(path))
        throw new ProtocolError(`invalid input path: ${path}`);
      let cursor = inputRoot;
      for (const part of path.split("/")) {
        cursor = join(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink())
          throw new ProtocolError(`symlink input refused: ${path}`);
      }
      const source = await realpath(join(inputRoot, path));
      const rel = relative(inputRoot, source);
      if (rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new ProtocolError(`input escapes root: ${path}`);
      if (!(await lstat(source)).isFile())
        throw new ProtocolError(`input is not a regular file: ${path}`);
      const destination = join(staging, path);
      await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o755 });
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await chmod(destination, 0o444);
      const data = await Bun.file(destination).arrayBuffer();
      inputs.push({
        path,
        sha256: createHash("sha256").update(new Uint8Array(data)).digest("hex"),
        size_bytes: data.byteLength,
      });
    }
    return { staging, inputs };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
export class DockerTransport implements SessionTransport {
  containerName = "";
  private process?: ReturnType<typeof Bun.spawn>;
  private staging?: string;
  private stopped = false;
  private expectedExit = false;
  private stopping?: Promise<void>;
  private config?: SessionConfig;
  async start(
    config: SessionConfig,
    sessionId: string,
    onMessage: (message: BridgeMessage) => Promise<void>,
    onFailure: (error: Error) => void,
  ): Promise<TransportMetadata> {
    this.config = config;
    this.containerName = `statigent-${sessionId}`;
    const info = JSON.parse(
      await dockerCommand(
        ["info", "--format", "{{json .}}"],
        config.limits.startup_timeout_ms,
      ),
    );
    if (
      !info.MemoryLimit ||
      !info.SwapLimit ||
      !info.PidsLimit ||
      !info.CpuCfsQuota ||
      !info.CpuCfsPeriod
    )
      throw new Error("Docker cannot apply required resource limits");
    const inspected = JSON.parse(
      await dockerCommand(
        ["image", "inspect", config.image],
        config.limits.startup_timeout_ms,
      ),
    )[0];
    if (inspected.Os !== "linux")
      throw new Error("execution image must use Linux");
    const containerPlatform = `${inspected.Os}/${inspected.Architecture}`;
    if (config.platform && config.platform !== containerPlatform)
      throw new Error(`image platform mismatch: ${containerPlatform}`);
    const staged = await stageInputs(config, sessionId);
    this.staging = staged.staging;
    if (this.stopped) {
      await rm(this.staging, { recursive: true, force: true });
      throw new Error("start cancelled");
    }
    const l = config.limits;
    const args = [
      "run",
      "--name",
      this.containerName,
      "--label",
      "org.statigent.runtime=1",
      "--label",
      `org.statigent.run=${config.run_id}`,
      "--label",
      `org.statigent.session=${sessionId}`,
      "-i",
      "--network",
      "none",
      "--read-only",
      "--user",
      "10001:10001",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--cpus",
      String(l.cpus),
      "--memory",
      String(l.memory_bytes),
      "--memory-swap",
      String(l.memory_bytes),
      "--pids-limit",
      String(l.pids),
      "--tmpfs",
      `/workspace:rw,noexec,nosuid,nodev,size=${l.workspace_bytes},uid=10001,gid=10001,mode=700`,
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,nodev,size=${l.tmp_bytes},mode=1777`,
      "--mount",
      `type=bind,source=${this.staging},target=/input,readonly`,
      "--workdir",
      "/workspace",
    ];
    for (const [key, value] of Object.entries({
      HOME: "/tmp",
      JUPYTER_RUNTIME_DIR: "/tmp/jupyter",
      MPLCONFIGDIR: "/tmp/matplotlib",
      PYTHONHASHSEED: String(config.seed),
      OPENBLAS_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1",
      NUMEXPR_NUM_THREADS: "1",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      no_proxy: "",
    }))
      args.push("--env", `${key}=${value}`);
    if (config.platform) args.push("--platform", config.platform);
    args.push(inspected.Id);
    this.process = Bun.spawn(["docker", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const proc = this.process;
    if (
      !(proc.stdout instanceof ReadableStream) ||
      !(proc.stderr instanceof ReadableStream)
    )
      throw new Error("Docker pipes unavailable");
    void this.readFrames(proc.stdout, config, sessionId, onMessage).catch(
      (e) => {
        if (!this.stopped)
          onFailure(e instanceof Error ? e : new Error(String(e)));
      },
    );
    let diagnostics = "";
    void (async () => {
      for await (const chunk of streamChunks(
        proc.stderr as ReadableStream<Uint8Array>,
      )) {
        diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(
          -8192,
        );
      }
    })().catch((e) => {
      if (!this.stopped) onFailure(new Error(`stderr pipe: ${e}`));
    });
    void proc.exited.then(async (code) => {
      if (this.stopped || this.expectedExit) return;
      let status = "";
      try {
        status = await dockerCommand([
          "inspect",
          "--format",
          "{{json .State}}",
          this.containerName,
        ]);
      } catch (e) {
        status = String(e);
      }
      onFailure(
        new Error(`container exited (${code}); ${status}; ${diagnostics}`),
      );
    });
    return {
      image_id: inspected.Id,
      image_digest: inspected.RepoDigests ?? [],
      container_platform: containerPlatform,
      docker_version: String(info.ServerVersion),
      inputs: staged.inputs,
      container_name: this.containerName,
    };
  }
  private async readFrames(
    stream: ReadableStream<Uint8Array>,
    config: SessionConfig,
    sessionId: string,
    onMessage: (message: BridgeMessage) => Promise<void>,
  ) {
    let pending = Buffer.alloc(0);
    for await (const chunk of streamChunks(stream)) {
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(10);
      while (newline >= 0) {
        const frame = pending.subarray(0, newline);
        if (frame.length > config.limits.max_frame_bytes)
          throw new ProtocolError("oversized bridge frame");
        if (frame.length)
          await onMessage(
            parseBridgeMessage(
              frame.toString("utf8"),
              config.limits.max_frame_bytes,
              sessionId,
            ),
          );
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
      if (pending.length > config.limits.max_frame_bytes)
        throw new ProtocolError("oversized unterminated bridge frame");
    }
    if (pending.length) throw new ProtocolError("incomplete final JSONL frame");
  }
  async send(message: HostRequest) {
    if (
      this.stopped ||
      !this.process ||
      !this.process.stdin ||
      typeof this.process.stdin === "number"
    )
      throw new Error("transport not running");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > (this.config?.limits.max_frame_bytes ?? 0))
      throw new ProtocolError("request frame exceeds limit");
    if (message.type === "shutdown") this.expectedExit = true;
    this.process.stdin.write(line);
    await this.process.stdin.flush();
  }
  stop(): Promise<void> {
    this.stopping ??= this.stopInternal();
    return this.stopping;
  }
  private async stopInternal() {
    this.stopped = true;
    let failure: unknown;
    try {
      if (this.containerName) {
        const ids = await dockerCommand([
          "ps",
          "-aq",
          "--filter",
          `name=^/${this.containerName}$`,
        ]);
        if (ids) await dockerCommand(["rm", "-f", this.containerName]);
      }
    } catch (e) {
      failure = e;
    }
    this.process?.kill();
    if (this.staging) {
      try {
        await rm(this.staging, { recursive: true, force: true });
      } catch (e) {
        failure ??= e;
      }
    }
    if (failure) throw failure;
  }
}
export async function cleanupRun(runId: string) {
  if (!/^[-a-zA-Z0-9_.]{1,128}$/.test(runId))
    throw new ProtocolError("invalid run_id");
  const ids = (
    await dockerCommand([
      "ps",
      "-aq",
      "--filter",
      "label=org.statigent.runtime=1",
      "--filter",
      `label=org.statigent.run=${runId}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  for (const id of ids) await dockerCommand(["rm", "-f", id]);
  return ids;
}

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}
