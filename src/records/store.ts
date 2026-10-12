import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentMetadata,
  type ModelMetadata,
  type PromptMetadata,
  type TokenLedger,
  validateAgentFields,
} from "./agent-metadata";

export interface RecordEvent {
  type: string;
  at: string;
  run_id: string;
  session_id: string;
  [key: string]: unknown;
}
export interface ArtifactReference {
  artifact_id: string;
  path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  complete: boolean;
  source_path?: string;
  cell_id?: string;
  request_id?: string;
  kernel_epoch?: number;
}
export interface InputIdentity {
  path: string;
  sha256: string;
  size_bytes: number;
}
export interface ImageIdentity {
  id: string;
  platform: string;
  digests?: string[];
}
export interface Manifest {
  schema_version: 1 | 2;
  run_kind?: "runtime" | "agent" | "code_replay";
  agent?: "not_applicable" | AgentMetadata;
  run_id: string;
  replay_of: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  config: Record<string, unknown>;
  inputs: InputIdentity[];
  image: ImageIdentity;
  environment: Record<string, unknown>;
  code: { commit: string | null; dirty: boolean | null };
  model: "not_applicable" | ModelMetadata;
  prompt: "not_applicable" | PromptMetadata;
  tokens: "not_applicable" | TokenLedger;
  split: "not_applicable";
  seed: number | null;
  artifacts: ArtifactReference[];
  workspace_collection: {
    status: "not_collected" | "complete" | "incomplete_or_unknown";
    reason: string | null;
  };
  export: { status: string; paths: string[]; error?: string };
  replay: { eligible: boolean; reasons: string[]; result: string };
  timing: {
    wall_ms: number;
    startup_ms: number;
    execution_ms: number;
    wait_ms: number;
    cleanup_ms: number;
    execution_count: number;
  };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function textField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length)
    throw new Error(`Invalid ${name}`);
  return value;
}
export function safeRelativePath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Unsafe relative path: ${path}`);
  return path;
}
export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}
async function gitValue(args: string[]): Promise<string | null> {
  const result = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(result.stdout).text();
  return (await result.exited) === 0 ? output.trim() : null;
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /secret|password|api.?key|credential|access.?token/i.test(key)
          ? "[REDACTED]"
          : redact(item),
      ]),
    );
  return value;
}

export interface CreateRecorderOptions {
  runRoot: string;
  runId?: string;
  config: Record<string, unknown>;
  inputs: InputIdentity[];
  image: ImageIdentity;
  environment?: Record<string, unknown>;
  replayOf?: string;
  seed?: number;
  agent?: {
    model: ModelMetadata;
    prompt: PromptMetadata;
    tokens: TokenLedger;
    metadata: AgentMetadata;
  };
  maxArtifactBytes?: number;
  maxTotalArtifactBytes?: number;
}

export class RunRecorder {
  readonly directory: string;
  readonly manifest: Manifest;
  private queue: Promise<void> = Promise.resolve();
  private failed: Error | undefined;
  private readonly started = performance.now();
  private totalArtifactBytes = 0;
  private seenCompleted = new Set<string>();
  private sessionStartedAt: number | undefined;
  private terminalFailure: string | undefined;
  private constructor(
    directory: string,
    manifest: Manifest,
    private options: CreateRecorderOptions,
  ) {
    this.directory = directory;
    this.manifest = manifest;
  }
  static async create(options: CreateRecorderOptions): Promise<RunRecorder> {
    const runId = options.runId ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId))
      throw new Error("Invalid run ID");
    await mkdir(resolve(options.runRoot), { recursive: true });
    const directory = join(resolve(options.runRoot), runId);
    await mkdir(directory, { mode: 0o700 });
    await mkdir(join(directory, "artifacts"));
    await mkdir(join(directory, "notebooks"));
    const [commit, dirty] = await Promise.all([
      gitValue(["rev-parse", "HEAD"]),
      gitValue(["status", "--porcelain"]),
    ]);
    const manifest: Manifest = {
      schema_version: 2,
      run_kind: options.agent
        ? "agent"
        : options.replayOf
          ? "code_replay"
          : "runtime",
      agent: options.agent?.metadata ?? "not_applicable",
      run_id: runId,
      replay_of: options.replayOf ?? null,
      started_at: new Date().toISOString(),
      ended_at: null,
      status: "starting",
      config: object(redact(options.config)),
      inputs: options.inputs,
      image: options.image,
      environment: {
        host_os: platform(),
        host_arch: arch(),
        host_release: release(),
        cpu: cpus()[0]?.model ?? null,
        logical_cpus: cpus().length,
        memory_bytes: totalmem(),
        bun: Bun.version,
        ...options.environment,
      },
      code: { commit, dirty: dirty === null ? null : dirty.length > 0 },
      model: options.agent?.model ?? "not_applicable",
      prompt: options.agent?.prompt ?? "not_applicable",
      tokens: options.agent?.tokens ?? "not_applicable",
      split: "not_applicable",
      seed: options.seed ?? null,
      artifacts: [],
      workspace_collection: { status: "not_collected", reason: null },
      export: { status: "not_requested", paths: [] },
      replay: {
        eligible: false,
        reasons: ["run_not_finished"],
        result: "not_requested",
      },
      timing: {
        wall_ms: 0,
        startup_ms: 0,
        execution_ms: 0,
        wait_ms: 0,
        cleanup_ms: 0,
        execution_count: 0,
      },
    };
    const recorder = new RunRecorder(directory, manifest, options);
    const events = await open(join(directory, "events.jsonl"), "wx", 0o600);
    await events.close();
    await recorder.saveManifest();
    return recorder;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.failed) throw this.failed;
      try {
        return await operation();
      } catch (cause) {
        this.failed = new Error(
          "Run record persistence failed; further execution is prohibited",
          { cause },
        );
        throw this.failed;
      }
    });
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async saveManifest(): Promise<void> {
    validateAgentFields(this.manifest as unknown as Record<string, unknown>);
    await writeJson(join(this.directory, "manifest.json"), this.manifest);
  }
  private async append(event: Record<string, unknown>): Promise<void> {
    const handle = await open(join(this.directory, "events.jsonl"), "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async onEvent(event: RecordEvent): Promise<void> {
    return this.enqueue(async () => {
      if (event.run_id !== this.manifest.run_id)
        throw new Error("Mismatched event run ID");
      const stored = { ...event };
      if (event.type === "session_start" && event.config)
        stored.config = redact(event.config);
      // Large output is referenced in the journal; the immutable snapshot keeps the full payload.
      if (event.type === "session_start")
        this.sessionStartedAt = performance.now();
      if (event.type === "output") {
        const message = event.message ? object(event.message) : event;
        const ref = await this.storeArtifact(
          Buffer.from(JSON.stringify(message.output)),
          "application/json",
          message,
          true,
          true,
        );
        if (event.message) {
          const copy = { ...message };
          delete copy.output;
          stored.message = copy;
        }
        delete stored.output;
        stored.output_ref = ref;
      }
      if (event.type === "artifact" && event.message) {
        const message = { ...object(event.message) };
        delete message.data_base64;
        stored.message = message;
      }
      await this.append(stored);
      const result =
        event.result && typeof event.result === "object"
          ? object(event.result)
          : null;
      if (
        event.type === "finish" &&
        result &&
        typeof result.request_id === "string" &&
        !this.seenCompleted.has(result.request_id)
      ) {
        this.seenCompleted.add(result.request_id);
        if (result.started === true) {
          this.manifest.timing.execution_count += 1;
          this.manifest.timing.execution_ms +=
            typeof result.elapsed_ms === "number" ? result.elapsed_ms : 0;
        }
        this.manifest.timing.wait_ms +=
          typeof result.waiting_ms === "number" ? result.waiting_ms : 0;
      }
      if (event.type === "ready") {
        this.manifest.status = "running";
        if (this.sessionStartedAt !== undefined) {
          this.manifest.timing.startup_ms +=
            performance.now() - this.sessionStartedAt;
          this.sessionStartedAt = undefined;
        }
        if (event.metadata) {
          const metadata = object(event.metadata);
          this.manifest.image = {
            id: textField(metadata.image_id, "image ID"),
            platform: textField(
              metadata.container_platform,
              "container platform",
            ),
            digests: stringArray(metadata.image_digest, "image digests"),
          };
          this.manifest.inputs = parseInputs(metadata.inputs);
          Object.assign(this.manifest.environment, {
            docker_version: metadata.docker_version,
            container_platform: metadata.container_platform,
            dependencies: metadata.dependencies ?? null,
          });
        }
      }
      if (event.type === "close" && typeof event.elapsed_ms === "number")
        this.manifest.timing.cleanup_ms += event.elapsed_ms;
      if (event.type === "failure") {
        this.terminalFailure =
          typeof event.status === "string" ? event.status : "failed";
        this.manifest.workspace_collection = {
          status: "incomplete_or_unknown",
          reason:
            typeof event.message === "string"
              ? event.message
              : "Container failure may have lost uncollected workspace files",
        };
      }
      if (event.type === "close") {
        if (
          event.status === "ok" &&
          !event.cleanup_error &&
          !this.terminalFailure
        )
          this.manifest.workspace_collection = {
            status: "complete",
            reason: null,
          };
        else {
          this.terminalFailure ??=
            typeof event.status === "string" && event.status !== "ok"
              ? event.status
              : "cleanup_failed";
          this.manifest.workspace_collection = {
            status: "incomplete_or_unknown",
            reason: String(event.cleanup_error ?? this.terminalFailure),
          };
        }
      }
      if (event.type === "phase" && typeof event.elapsed_ms === "number") {
        if (event.phase === "startup")
          this.manifest.timing.startup_ms += event.elapsed_ms;
        if (event.phase === "cleanup")
          this.manifest.timing.cleanup_ms += event.elapsed_ms;
      }
      await this.saveManifest();
    });
  }
  private async storeArtifact(
    data: Uint8Array,
    mime: string,
    source: Record<string, unknown>,
    complete: boolean,
    output = false,
  ): Promise<ArtifactReference> {
    const limit = output
      ? 16 * 1024 * 1024
      : (this.options.maxArtifactBytes ?? 16 * 1024 * 1024);
    const totalLimit = this.options.maxTotalArtifactBytes ?? 128 * 1024 * 1024;
    if (
      data.length > limit ||
      this.totalArtifactBytes + data.length > totalLimit
    )
      throw new Error("Artifact persistence limit exceeded");
    if (
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(
        mime,
      )
    )
      throw new Error("Invalid MIME type");
    const id = randomUUID();
    const relative = `artifacts/${id}`;
    const handle = await open(join(this.directory, relative), "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const ref: ArtifactReference = {
      artifact_id: id,
      path: relative,
      mime_type: mime,
      size_bytes: data.length,
      sha256: sha256(data),
      complete,
    };
    if (typeof source.path === "string")
      ref.source_path = safeRelativePath(source.path);
    if (typeof source.cell_id === "string") ref.cell_id = source.cell_id;
    if (typeof source.request_id === "string")
      ref.request_id = source.request_id;
    if (typeof source.kernel_epoch === "number")
      ref.kernel_epoch = source.kernel_epoch;
    this.totalArtifactBytes += data.length;
    this.manifest.artifacts.push(ref);
    return ref;
  }
  async onArtifact(messageValue: unknown): Promise<ArtifactReference> {
    return this.enqueue(async () => {
      const message = object(messageValue);
      const path = textField(message.path, "artifact path");
      safeRelativePath(path);
      const encoded = message.data_base64;
      if (typeof encoded !== "string") throw new Error("Invalid artifact data");
      if (
        encoded.length >
        Math.ceil((this.options.maxArtifactBytes ?? 16 * 1024 * 1024) / 3) * 4
      )
        throw new Error("Artifact too large");
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded,
        )
      )
        throw new Error("Invalid base64");
      const data = Buffer.from(encoded, "base64");
      if (
        typeof message.size_bytes === "number" &&
        message.size_bytes !== data.length
      )
        throw new Error("Artifact size mismatch");
      const ref = await this.storeArtifact(
        data,
        textField(message.mime_type, "MIME type"),
        message,
        message.complete !== false,
      );
      await this.append({
        type: "artifact_saved",
        at: new Date().toISOString(),
        run_id: this.manifest.run_id,
        artifact: ref,
      });
      await this.saveManifest();
      return ref;
    });
  }
  async modelEvent(
    type: string,
    fields: Record<string, unknown>,
    content?: unknown,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (
        ![
          "model_request",
          "model_response",
          "model_failure",
          "tool_validation",
          "agent_budget",
          "agent_finish",
        ].includes(type)
      )
        throw new Error("Invalid agent event type");
      const agent = this.manifest.agent;
      if (!agent || agent === "not_applicable")
        throw new Error("Agent metadata required");
      let contentRef: ArtifactReference | undefined;
      if (content !== undefined) {
        const bytes = Buffer.from(JSON.stringify(content));
        if (agent.trace_bytes + bytes.length > agent.budget.max_trace_bytes) {
          agent.trace_incomplete = true;
          await this.append({
            type: "model_trace_limit",
            at: new Date().toISOString(),
            run_id: this.manifest.run_id,
            omitted_bytes: bytes.length,
          });
          await this.saveManifest();
          throw new Error("Model trace persistence limit exceeded");
        }
        // Dedicated quota: model history cannot consume or enlarge execution output limits.
        const id = randomUUID();
        const relative = `artifacts/${id}`;
        const handle = await open(join(this.directory, relative), "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        contentRef = {
          artifact_id: id,
          path: relative,
          mime_type: "application/json",
          size_bytes: bytes.length,
          sha256: sha256(bytes),
          complete: true,
        };
        this.manifest.artifacts.push(contentRef);
        agent.trace_bytes += bytes.length;
      }
      await this.append({
        type,
        at: new Date().toISOString(),
        run_id: this.manifest.run_id,
        ...fields,
        ...(contentRef ? { content_ref: contentRef } : {}),
      });
      await this.saveManifest();
    });
  }
  async finish(status: string): Promise<void> {
    return this.enqueue(async () => {
      if (status === "completed" && this.terminalFailure)
        status = this.terminalFailure;
      this.manifest.status = status;
      this.manifest.ended_at = new Date().toISOString();
      this.manifest.timing.wall_ms = performance.now() - this.started;
      await this.append({
        type: "run_finished",
        at: this.manifest.ended_at,
        run_id: this.manifest.run_id,
        status,
      });
      await this.saveManifest();
    });
  }
}

export async function readArtifact(
  directory: string,
  reference: unknown,
): Promise<Buffer> {
  const ref = object(reference);
  const path = safeRelativePath(textField(ref.path, "artifact path"));
  if (!path.startsWith("artifacts/") || path.split("/").length !== 2)
    throw new Error("Artifact outside record area");
  const filePath = join(directory, path);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Artifact must be a regular file");
  const data = await readFile(filePath);
  if (sha256(data) !== ref.sha256 || data.length !== ref.size_bytes)
    throw new Error("Artifact integrity mismatch");
  return data;
}
export async function readEvents(
  directory: string,
): Promise<Record<string, unknown>[]> {
  const content = await readFile(join(directory, "events.jsonl"), "utf8");
  const events: Record<string, unknown>[] = [];
  const lines = content.split("\n");
  const truncated = !content.endsWith("\n") && content.length > 0;
  if (truncated) lines.pop();
  for (const line of lines.filter(Boolean)) {
    const event = object(JSON.parse(line));
    if (event.output_ref) {
      const output: unknown = JSON.parse(
        (await readArtifact(directory, event.output_ref)).toString(),
      );
      if (event.message) object(event.message).output = output;
      else event.output = output;
    }
    events.push(event);
  }
  if (truncated)
    events.push({
      type: "journal_truncated",
      message: "Incomplete final event omitted; its result remains unknown",
    });
  return events;
}
export async function readManifest(directory: string): Promise<Manifest> {
  const value = object(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  if (
    (value.schema_version !== 1 && value.schema_version !== 2) ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.artifacts)
  )
    throw new Error("Invalid run manifest");
  textField(value.run_id, "run ID");
  object(value.config);
  const image = object(value.image);
  const timing = object(value.timing);
  textField(image.id, "image ID");
  textField(image.platform, "platform");
  if (image.digests !== undefined) stringArray(image.digests, "image digests");
  parseInputs(value.inputs);
  object(value.environment);
  object(value.code);
  for (const key of [
    "wall_ms",
    "startup_ms",
    "execution_ms",
    "wait_ms",
    "cleanup_ms",
    "execution_count",
  ])
    nonnegative(timing[key], key);
  const exported = object(value.export);
  textField(exported.status, "export status");
  stringArray(exported.paths, "notebook paths").forEach(safeRelativePath);
  const replay = object(value.replay);
  if (typeof replay.eligible !== "boolean")
    throw new Error("Invalid replay eligibility");
  stringArray(replay.reasons, "replay reasons");
  textField(replay.result, "replay result");
  const collection = object(value.workspace_collection);
  if (
    !["not_collected", "complete", "incomplete_or_unknown"].includes(
      String(collection.status),
    )
  )
    throw new Error("Invalid collection status");
  if (collection.reason !== null)
    textField(collection.reason, "collection reason");
  for (const item of value.artifacts) {
    const ref = object(item);
    safeRelativePath(textField(ref.path, "artifact path"));
    textField(ref.artifact_id, "artifact ID");
    textField(ref.mime_type, "MIME");
    checksum(ref.sha256);
    nonnegative(ref.size_bytes, "artifact size");
    if (typeof ref.complete !== "boolean")
      throw new Error("Invalid completeness");
  }
  for (const key of ["started_at", "status"]) textField(value[key], key);
  if (value.ended_at !== null) textField(value.ended_at, "ended_at");
  if (value.replay_of !== null) textField(value.replay_of, "replay_of");
  if (value.seed !== null) nonnegative(value.seed, "seed");
  validateAgentFields(value);
  return value as unknown as Manifest;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`Invalid ${label}`);
  return value;
}
function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`Invalid ${label}`);
  return value;
}
function checksum(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid SHA-256");
  return value;
}
function parseInputs(value: unknown): InputIdentity[] {
  if (!Array.isArray(value)) throw new Error("Invalid input identities");
  return value.map((item) => {
    const entry = object(item);
    return {
      path: safeRelativePath(textField(entry.path, "input path")),
      sha256: checksum(entry.sha256),
      size_bytes: nonnegative(entry.size_bytes, "input size"),
    };
  });
}
