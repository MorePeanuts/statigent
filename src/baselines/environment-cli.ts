import { join } from "node:path";
import { Command } from "commander";
import * as z from "zod";
import { command } from "../evaluation/process";
import {
  datawiseRoot,
  environmentIdentity,
  prepareDatawiseSource,
  repositoryRoot,
  verifyDatawiseSource,
} from "./source";

const cli = new Command().name("baseline-environment");
cli
  .command("prepare-source")
  .description("显式下载并校验固定 DatawiseAgent 编排源码")
  .action(async () => {
    await prepareDatawiseSource();
    console.log(
      JSON.stringify({ method: "datawiseagent", source: "verified" }),
    );
  });
cli
  .command("probe")
  .requiredOption("--method <method>")
  .action(async (options: unknown) => {
    const { method } = z
      .strictObject({ method: z.enum(["autogen", "datawiseagent"]) })
      .parse(options);
    const identity = await environmentIdentity(method);
    if (method === "datawiseagent") await verifyDatawiseSource();
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHON_DOTENV_DISABLED: "1",
      UV_PYTHON_DOWNLOADS: "never",
      // 仅定位 uv 缓存，不能透传模型密钥、代理或 CUSTOM_CONFIG。
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    };
    const result = await command(
      [
        "uv",
        "run",
        "--project",
        identity.root,
        "--frozen",
        "--offline",
        "python",
        join(repositoryRoot, "python/statigent_baselines/probe.py"),
        method,
        ...(method === "datawiseagent" ? ["--source", datawiseRoot] : []),
      ],
      { env, timeout_ms: 30000 },
    );
    console.log(
      JSON.stringify({
        ...identity,
        result: JSON.parse(result.stdout),
        stderr: result.stderr,
      }),
    );
  });
await cli.parseAsync();
