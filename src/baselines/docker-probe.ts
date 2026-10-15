import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import * as z from "zod";
import { command } from "../evaluation/process";

const cli = new Command()
  .name("baseline-docker-probe")
  .requiredOption("--method <method>")
  .option("--checks-only", "只运行依赖/资源检查")
  .requiredOption("--output <directory>");
cli.action(async (value: unknown) => {
  const options = z
    .strictObject({
      method: z.enum(["compute", "autogluon"]),
      output: z.string().min(1),
      checksOnly: z.boolean().default(false),
    })
    .parse(value);
  const directory = resolve(options.output);
  await mkdir(directory, { recursive: false });
  const name = `statigent-baseline-probe-${randomUUID()}`;
  const tag =
    options.method === "compute"
      ? "statigent-runtime:baselines-cpu-v1"
      : "statigent-runtime:autogluon-cpu-v1";
  const inspect = await command([
    "docker",
    "image",
    "inspect",
    tag,
    "--format",
    "{{json .}}",
  ]);
  const identity = JSON.parse(inspect.stdout);
  const image = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .parse(identity.Id);
  const start = performance.now();
  let result: { stdout: string; stderr: string } | null = null;
  let failure: string | null = null,
    cleanup: string | null = null;
  try {
    result = await command(
      [
        "docker",
        "run",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--user",
        "10001:10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--memory-swap",
        "4g",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=256m,uid=10001,gid=10001",
        "--tmpfs",
        "/workspace:rw,nosuid,size=2g,uid=10001,gid=10001",
        "--tmpfs",
        "/quota:rw,noexec,nosuid,size=8m,uid=10001,gid=10001",
        "--env",
        "TMPDIR=/workspace",
        "--entrypoint",
        "uv",
        image,
        "run",
        "--frozen",
        "--offline",
        "--project",
        "/opt/runtime",
        "python",
        `/opt/runtime/python/statigent_baselines/${options.method === "compute" || options.checksOnly ? "compute_probe" : "autogluon_probe"}.py`,
      ],
      {
        timeout_ms: 240000,
        stdout_limit: 1024 ** 2,
        stderr_limit: 2 * 1024 ** 2,
      },
    );
  } catch (error) {
    failure = String(error);
  } finally {
    try {
      await command(["docker", "rm", "-f", name], { timeout_ms: 15000 });
    } catch (error) {
      cleanup = String(error);
    }
  }
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify(
      {
        schema_version: 1,
        method: options.method,
        image,
        architecture: identity.Architecture,
        os: identity.Os,
        wall_ms: performance.now() - start,
        result: result ? JSON.parse(result.stdout) : null,
        failure,
        cleanup,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  if (result)
    await writeFile(resolve(directory, "stderr.txt"), result.stderr, {
      flag: "wx",
    });
  if (failure || cleanup) throw new Error(failure ?? cleanup ?? "probe_failed");
  console.log(JSON.stringify({ directory, status: "passed", image }));
});
await cli.parseAsync();
