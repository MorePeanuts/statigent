export function commandEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "UV_CACHE_DIR",
    "UV_PYTHON_DOWNLOADS",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
export async function command(
  args: string[],
  options: {
    input?: string;
    timeout_ms?: number;
    signal?: AbortSignal;
    stdout_limit?: number;
    stderr_limit?: number;
    env?: Record<string, string>;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  const p = Bun.spawn(args, {
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ?? commandEnvironment(),
  });
  let failure: Error | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    p.kill("SIGKILL");
  };
  const abort = () => stop(new Error("Command cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => stop(new Error("Command timed out")),
    options.timeout_ms ?? 10000,
  );
  const collect = async (stream: ReadableStream<Uint8Array>, limit: number) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        size += chunk.length;
        if (size > limit) {
          stop(new Error("Command output limit exceeded"));
          break;
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [stdout, stderr, code] = await Promise.all([
      collect(p.stdout, options.stdout_limit ?? 1048576),
      collect(p.stderr, options.stderr_limit ?? 1048576),
      p.exited,
    ]);
    if (failure) throw failure;
    if (code !== 0)
      throw new Error(`Command failed (${code}): ${stderr.slice(0, 4096)}`);
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
