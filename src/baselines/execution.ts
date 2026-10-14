import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeFile } from "../evaluation/files";
import { createSession } from "../execution/factory";
import type {
  ArtifactRef,
  SessionConfig,
  SessionObserver,
} from "../execution/protocol";
import { sha256 } from "../records/store";
import { BRIDGE_LIMITS, relativePathSchema } from "./protocol";

export type BaselineSession = Awaited<ReturnType<typeof createSession>>;
/** 只返回已经由隔离执行器收集、校验并保存的本次产物。 */
export class BaselineArtifacts {
  private files = new Map<string, ArtifactRef>();
  private bytes = 0;
  constructor(
    readonly directory: string,
    readonly maxBytes: number,
  ) {}
  async capture(
    message: Parameters<NonNullable<SessionObserver["onArtifact"]>>[0],
  ) {
    const path = relativePathSchema.parse(message.path);
    const data = Buffer.from(message.data_base64, "base64");
    if (
      data.toString("base64") !== message.data_base64 ||
      this.bytes + data.length > this.maxBytes
    )
      throw new Error("Invalid/oversized baseline artifact");
    const artifactId = randomUUID();
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, artifactId), data, {
      flag: "wx",
      mode: 0o600,
    });
    const ref: ArtifactRef = {
      artifact_id: artifactId,
      path,
      sha256: sha256(data),
      size_bytes: data.length,
      mime_type: message.mime_type,
      complete: true,
    };
    this.bytes += data.length;
    this.files.set(path, ref);
    return ref;
  }
  list() {
    return [...this.files.values()].map((x) => ({ ...x }));
  }
  async read(path: string) {
    const ref = this.files.get(relativePathSchema.parse(path));
    if (!ref) throw new Error("Artifact not collected in this run");
    const actual = await describeFile(this.directory, ref.artifact_id);
    if (actual.sha256 !== ref.sha256 || actual.bytes !== ref.size_bytes)
      throw new Error("Collected artifact changed");
    return readFile(join(this.directory, ref.artifact_id));
  }
  async response(path: string) {
    const data = await this.read(path);
    if ((data.length * 4) / 3 + 2048 > BRIDGE_LIMITS.response_bytes)
      throw new Error("Artifact exceeds bridge response limit");
    return {
      path,
      data_base64: data.toString("base64"),
      sha256: sha256(data),
      bytes: data.length,
    };
  }
}

export async function baselineExecution(
  options: {
    config: SessionConfig;
    artifactDirectory: string;
    event: (type: string, details: Record<string, unknown>) => Promise<void>;
  },
  dependencies: { create?: typeof createSession } = {},
) {
  const artifacts = new BaselineArtifacts(
    options.artifactDirectory,
    options.config.limits.max_artifacts_bytes,
  );
  const session = await (dependencies.create ?? createSession)(options.config, {
    onEvent: (event) => options.event("execution_event", { event }),
    onArtifact: (message) => artifacts.capture(message),
  });
  let active = false,
    closed = false;
  return {
    session,
    artifacts,
    async execute(code: string, requestId: string, signal: AbortSignal) {
      if (closed || active) throw new Error("Execution closed or busy");
      signal.throwIfAborted();
      active = true;
      let cancellation: Promise<unknown> | undefined;
      const cancel = () => {
        cancellation ??= session.cancel(requestId);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await options.event("execution_requested", {
          request_id: requestId,
          code,
        });
        signal.throwIfAborted();
        const result = await session.execute(code, { requestId });
        await options.event("execution_completed", {
          request_id: requestId,
          result,
        });
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
        await cancellation;
        active = false;
      }
    },
    async close() {
      closed = true;
      await session.close();
    },
  };
}
